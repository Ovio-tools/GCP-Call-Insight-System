import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { KeyStore } from '../crypto/key-store.js';
import { query } from '../db/sql.js';
import type { RestrictedRunner } from '../db/restricted/restricted-context.js';
import { RETENTION_ADVISORY_LOCK_KEY } from '../retention/purge.js';
import {
  allocateNextKeyVersion,
  getActiveKeyVersion,
  insertRotatingKeyVersion,
  markDestroyRequested,
  updateStatus,
} from '../db/repositories/key-versions-repo.js';
import { getActiveKek } from '../db/repositories/kek-versions-repo.js';
import { insertLifecycleEvent } from '../db/repositories/key-lifecycle-events-repo.js';
import { reencryptRawTranscripts, reencryptTokenVault, countRecoverableAtVersion } from './reencrypt.js';
import { finalizeUnderLock } from './finalize-destruction.js';
import type { MaintenanceController } from './maintenance-controller.js';
import { KeyLifecycleError } from './errors.js';

/** A KeyProvider whose DB-sourced active-version cache can be dropped after the rotation swap. */
type InvalidatableKeyProvider = KeyProvider & { invalidateActiveVersion?: () => void };

export interface RotateKeyDeps {
  /** App+key-admin capable pool: advisory lock, key_versions/kek_versions/events, and raw_transcripts. */
  pool: Pool;
  /** Restricted runner for token_vault ciphertext (key-admin is never granted vault access). */
  restrictedRunner: RestrictedRunner;
  keyStore: KeyStore;
  /** Store-backed provider that resolves BOTH the old and new DEK for the re-encryption sweep. */
  keyProvider: InvalidatableKeyProvider;
  maintenance: MaintenanceController;
  config: Config;
  actor: string;
  approvalRef?: string;
  reason?: string;
  now?: () => Date;
  logger?: Logger;
}

export interface RotateKeyResult {
  oldVersion: number;
  newVersion: number;
  rowsReencrypted: number;
  recoveryWindowUntil: Date;
  /** True when the recovery window was zero and the old DEK was finalized inline. */
  finalizedInline: boolean;
}

/**
 * Key rotation, Phase A (Task 8.2). Under the shared advisory lock (mutually exclusive with the
 * retention purge): allocate → createDek → insert `rotating` (compensating `destroyDek` on insert
 * failure) → atomic active swap (retire old FIRST, then activate new) → pause + drain the queue →
 * re-encrypt raw+vault old→new → verify no recoverable old-version ciphertext → mark destroy
 * requested + `destroyDek(old)` → release. With a zero recovery window the finalizer runs inline;
 * otherwise Phase B (`confirm-destruction`) finalizes after the window. Crash-resumable (continues
 * an interrupted `rotating` version) and refuses to start while a prior destruction is unfinished.
 */
export async function rotateKey(deps: RotateKeyDeps): Promise<RotateKeyResult> {
  if (!deps.actor || deps.actor.trim() === '') {
    throw new Error('rotateKey: --actor is required');
  }
  const justification = deps.approvalRef ?? deps.reason;
  if (!justification || justification.trim() === '') {
    throw new Error('rotateKey: either --approval-ref or --reason is required');
  }
  const now = deps.now ?? (() => new Date());
  const batch = deps.config.RETENTION_PURGE_BATCH_SIZE;
  const windowDays = deps.config.KEY_STORE_RECOVERY_WINDOW_DAYS;

  const client = await deps.pool.connect();
  try {
    const locked = (
      await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        RETENTION_ADVISORY_LOCK_KEY,
      ])
    ).rows[0]?.ok;
    if (!locked) {
      throw new KeyLifecycleError(
        'KEY_ROTATION_FAILED',
        'rotateKey: another rotation/retention run holds the advisory lock',
      );
    }
    try {
      return await runRotation(client, deps, { now, batch, windowDays, justification });
    } catch (err) {
      // Sanitized audit of the abort; the CLI maps KeyLifecycleError → the §4 alert.
      await insertLifecycleEvent(client, { event: 'rotate_failed', actor: deps.actor }).catch(
        () => undefined,
      );
      throw err;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_ADVISORY_LOCK_KEY]).catch(
        () => undefined,
      );
    }
  } finally {
    client.release();
  }
}

async function runRotation(
  client: PoolClient,
  deps: RotateKeyDeps,
  ctx: { now: () => Date; batch: number; windowDays: number; justification: string },
): Promise<RotateKeyResult> {
  // Refuse to start while a prior destruction is unfinished (would race the finalizer).
  const pending = await query<{ key_version: number }>(
    client,
    `SELECT key_version FROM key_versions WHERE destroy_requested_at IS NOT NULL AND destroyed_at IS NULL`,
  );
  if (pending.length > 0) {
    throw new KeyLifecycleError(
      'KEY_ROTATION_FAILED',
      'rotateKey: a prior destruction is pending — run confirm-destruction before rotating again',
    );
  }

  const oldVersion = await getActiveKeyVersion(client);

  // Resume an interrupted rotation (an existing `rotating` version), else start fresh.
  const rotating = await query<{ key_version: number }>(
    client,
    `SELECT key_version FROM key_versions WHERE status = 'rotating' ORDER BY key_version DESC LIMIT 1`,
  );
  let newVersion: number;
  if (rotating.length > 0) {
    newVersion = rotating[0]!.key_version;
  } else {
    const kekVersion = await getActiveKek(client);
    newVersion = await allocateNextKeyVersion(client);
    const created = await deps.keyStore.createDek({ keyVersion: newVersion, kekVersion });
    try {
      await insertRotatingKeyVersion(client, {
        keyVersion: newVersion,
        wrappedDekRef: created.wrappedRef,
        kekVersion,
      });
    } catch (err) {
      // Compensate the orphaned external DEK so a failed insert never strands key material.
      await deps.keyStore.destroyDek(newVersion).catch(() => undefined);
      throw err;
    }
    await insertLifecycleEvent(client, {
      event: 'rotate_started',
      keyVersion: newVersion,
      kekVersion,
      actor: deps.actor,
      approvalRef: ctx.justification,
    });
  }

  // Atomic active swap (retire old FIRST so the single-active index is never transiently violated).
  const status = (
    await query<{ status: string }>(client, `SELECT status FROM key_versions WHERE key_version = $1`, [
      newVersion,
    ])
  )[0]?.status;
  if (status === 'rotating') {
    await client.query('BEGIN');
    try {
      await updateStatus(client, oldVersion, { from: 'active', to: 'retired' });
      await updateStatus(client, newVersion, { from: 'rotating', to: 'active' });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    deps.keyProvider.invalidateActiveVersion?.();
  }

  // Pause consumption and drain in-flight jobs, then re-encrypt uncontended.
  await deps.maintenance.begin();
  let rowsReencrypted = 0;
  try {
    const drained = await deps.maintenance.waitForDrain();
    if (!drained) {
      throw new KeyLifecycleError(
        'KEY_ROTATION_FAILED',
        'rotateKey: in-flight jobs did not drain within KEY_ROTATION_DRAIN_TIMEOUT_MS',
      );
    }
    const rawN = await reencryptRawTranscripts(deps.pool, {
      oldVersion,
      newVersion,
      keyProvider: deps.keyProvider,
      batch: ctx.batch,
    });
    const vaultN = await reencryptTokenVault(deps.restrictedRunner, {
      oldVersion,
      newVersion,
      keyProvider: deps.keyProvider,
      batch: ctx.batch,
    });
    rowsReencrypted = rawN + vaultN;
  } finally {
    await deps.maintenance.end();
  }

  // Verify: no recoverable ciphertext left at the old version.
  const counts = await countRecoverableAtVersion(deps.pool, deps.restrictedRunner, oldVersion);
  if (counts.total > 0) {
    throw new KeyLifecycleError(
      'KEY_ROTATION_FAILED',
      `rotateKey: verify found ${counts.total} recoverable rows still at key_version ${oldVersion}`,
    );
  }

  // Phase A destroy-request (recovery window) + external destroy.
  const recoveryWindowUntil = new Date(ctx.now().getTime() + ctx.windowDays * 24 * 60 * 60 * 1000);
  await markDestroyRequested(client, oldVersion, {
    recoveryWindowUntil,
    approvalRef: ctx.justification,
  });
  await deps.keyStore.destroyDek(oldVersion);
  await insertLifecycleEvent(client, {
    event: 'destroy_requested',
    keyVersion: oldVersion,
    actor: deps.actor,
    approvalRef: ctx.justification,
    rowsReencrypted,
  });
  await insertLifecycleEvent(client, {
    event: 'rotate_completed',
    keyVersion: newVersion,
    actor: deps.actor,
    approvalRef: ctx.justification,
    rowsReencrypted,
  });

  // Zero window → finalize inline under the lock we already hold.
  let finalizedInline = false;
  if (ctx.windowDays === 0) {
    await finalizeUnderLock(client, {
      pool: deps.pool,
      keyStore: deps.keyStore,
      actor: deps.actor,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
    finalizedInline = true;
  }

  return { oldVersion, newVersion, rowsReencrypted, recoveryWindowUntil, finalizedInline };
}
