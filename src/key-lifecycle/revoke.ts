import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { KeyStore } from '../crypto/key-store.js';
import { query } from '../db/sql.js';
import type { RestrictedRunner } from '../db/restricted/restricted-context.js';
import { RETENTION_ADVISORY_LOCK_KEY } from '../retention/purge.js';
import {
  getActiveKeyVersion,
  listVersionsByKek,
  markDestroyRequested,
} from '../db/repositories/key-versions-repo.js';
import { markKekDestroyRequested } from '../db/repositories/kek-versions-repo.js';
import { insertLifecycleEvent } from '../db/repositories/key-lifecycle-events-repo.js';
import { countRecoverableAtVersion } from './reencrypt.js';
import { finalizeUnderLock } from './finalize-destruction.js';
import { KeyLifecycleError } from './errors.js';

export interface RevokeDeps {
  pool: Pool;
  restrictedRunner: RestrictedRunner;
  keyStore: KeyStore;
  config: Config;
  actor: string;
  approvalRef?: string;
  reason?: string;
  confirmationMatched?: boolean;
  now?: () => Date;
  logger?: Logger;
}

export interface RevokeResult {
  affectedRaw: number;
  affectedVault: number;
  affectedVersions: number[];
  finalizedInline: boolean;
}

function validate(deps: RevokeDeps): string {
  if (!deps.config.CRYPTO_KEY_DESTROY_COMMANDS_ENABLED) {
    throw new KeyLifecycleError(
      'KEY_REVOCATION_FAILED',
      'revoke: destructive key commands are disabled (CRYPTO_KEY_DESTROY_COMMANDS_ENABLED=false)',
    );
  }
  if (!deps.actor || deps.actor.trim() === '') {
    throw new KeyLifecycleError('KEY_REVOCATION_FAILED', 'revoke: --actor is required');
  }
  const justification = deps.approvalRef ?? deps.reason;
  if (!justification || justification.trim() === '') {
    throw new KeyLifecycleError(
      'KEY_REVOCATION_FAILED',
      'revoke: either --approval-ref or --reason is required',
    );
  }
  return justification;
}

async function withLock<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const locked = (
      await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        RETENTION_ADVISORY_LOCK_KEY,
      ])
    ).rows[0]?.ok;
    if (!locked) {
      throw new KeyLifecycleError(
        'KEY_REVOCATION_FAILED',
        'revoke: another rotation/retention run holds the advisory lock',
      );
    }
    try {
      return await fn(client);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [RETENTION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Emergency DEK revocation (Task 8.2): destroy the external material for ONE `key_version`, making
 * every row it encrypts unreadable everywhere (live DB + backups) once the recovery window elapses.
 * The target must NOT be the active version — rotate away first, so single-active holds. Two-phase:
 * Phase A stamps the destroy request + `destroyDek`; Phase B (`confirm-destruction`, or inline when
 * the window is zero) confirms unrecoverability and marks destroyed.
 */
export async function revokeDek(deps: RevokeDeps, keyVersion: number): Promise<RevokeResult> {
  const justification = validate(deps);
  const now = deps.now ?? (() => new Date());
  const windowDays = deps.config.KEY_STORE_RECOVERY_WINDOW_DAYS;

  return withLock(deps.pool, async (client) => {
    try {
      const active = await getActiveKeyVersion(client);
      if (active === keyVersion) {
        throw new KeyLifecycleError(
          'KEY_REVOCATION_FAILED',
          `revoke: refusing to revoke the ACTIVE key_version ${keyVersion} — rotate away first`,
        );
      }
      const status = (
        await query<{ status: string }>(
          client,
          `SELECT status FROM key_versions WHERE key_version = $1`,
          [keyVersion],
        )
      )[0]?.status;
      if (!status) {
        throw new KeyLifecycleError(
          'KEY_REVOCATION_FAILED',
          `revoke: key_version ${keyVersion} not found`,
        );
      }
      if (status !== 'retired') {
        throw new KeyLifecycleError(
          'KEY_REVOCATION_FAILED',
          `revoke: key_version ${keyVersion} is '${status}', must be 'retired' to revoke`,
        );
      }

      const affected = await countRecoverableAtVersion(
        deps.pool,
        deps.restrictedRunner,
        keyVersion,
      );
      const recoveryWindowUntil = new Date(now().getTime() + windowDays * 24 * 60 * 60 * 1000);
      await markDestroyRequested(client, keyVersion, {
        recoveryWindowUntil,
        approvalRef: justification,
      });
      await deps.keyStore.destroyDek(keyVersion);
      await insertLifecycleEvent(client, {
        event: 'revoke_dek',
        keyVersion,
        actor: deps.actor,
        approvalRef: justification,
        confirmationMatched: deps.confirmationMatched ?? null,
        affectedRawCount: affected.raw,
        affectedVaultCount: affected.vault,
      });

      const finalizedInline = await maybeFinalizeInline(client, deps, windowDays);
      return {
        affectedRaw: affected.raw,
        affectedVault: affected.vault,
        affectedVersions: [keyVersion],
        finalizedInline,
      };
    } catch (err) {
      await insertLifecycleEvent(client, { event: 'revoke_failed', actor: deps.actor }).catch(
        () => undefined,
      );
      throw err;
    }
  });
}

/**
 * Emergency KEK revocation (Task 8.2): the blast radius is EVERY `key_version` wrapped by the KEK.
 * Enumerates them, stamps a destroy request + `destroyDek` on each, then `markKekDestroyRequested` +
 * `destroyKek`. The active version must not be under the target KEK (rotate the KEK + key first).
 * Cross-version raw+vault counts are recorded for the audit event and the impact statement.
 */
export async function revokeKek(deps: RevokeDeps, kekVersion: string): Promise<RevokeResult> {
  const justification = validate(deps);
  const now = deps.now ?? (() => new Date());
  const windowDays = deps.config.KEY_STORE_RECOVERY_WINDOW_DAYS;

  return withLock(deps.pool, async (client) => {
    try {
      const activeVersion = await getActiveKeyVersion(client);
      const versions = await listVersionsByKek(client, kekVersion);
      if (versions.some((v) => v.key_version === activeVersion)) {
        throw new KeyLifecycleError(
          'KEY_REVOCATION_FAILED',
          `revoke: the active key_version is under KEK ${kekVersion} — rotate the KEK + key away first`,
        );
      }

      const recoveryWindowUntil = new Date(now().getTime() + windowDays * 24 * 60 * 60 * 1000);
      let affectedRaw = 0;
      let affectedVault = 0;
      const affectedVersions: number[] = [];
      for (const v of versions) {
        if (v.status === 'destroyed') continue;
        const affected = await countRecoverableAtVersion(
          deps.pool,
          deps.restrictedRunner,
          v.key_version,
        );
        affectedRaw += affected.raw;
        affectedVault += affected.vault;
        affectedVersions.push(v.key_version);
        if (v.destroy_requested_at === null) {
          await markDestroyRequested(client, v.key_version, {
            recoveryWindowUntil,
            approvalRef: justification,
          });
        }
        await deps.keyStore.destroyDek(v.key_version);
      }

      await markKekDestroyRequested(client, kekVersion, {
        recoveryWindowUntil,
        approvalRef: justification,
      });
      await deps.keyStore.destroyKek(kekVersion);
      await insertLifecycleEvent(client, {
        event: 'revoke_kek',
        kekVersion,
        actor: deps.actor,
        approvalRef: justification,
        confirmationMatched: deps.confirmationMatched ?? null,
        affectedRawCount: affectedRaw,
        affectedVaultCount: affectedVault,
      });

      const finalizedInline = await maybeFinalizeInline(client, deps, windowDays);
      return { affectedRaw, affectedVault, affectedVersions, finalizedInline };
    } catch (err) {
      await insertLifecycleEvent(client, { event: 'revoke_failed', actor: deps.actor }).catch(
        () => undefined,
      );
      throw err;
    }
  });
}

async function maybeFinalizeInline(
  client: PoolClient,
  deps: RevokeDeps,
  windowDays: number,
): Promise<boolean> {
  if (windowDays !== 0) return false;
  await finalizeUnderLock(client, {
    pool: deps.pool,
    keyStore: deps.keyStore,
    actor: deps.actor,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  return true;
}
