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
import {
  reencryptRawTranscripts,
  reencryptTokenVault,
  countRecoverableAtVersion,
} from './reencrypt.js';
import { finalizeUnderLock } from './finalize-destruction.js';
import type { MaintenanceController } from './maintenance-controller.js';
import { KeyLifecycleError } from './errors.js';

/** A KeyProvider whose DB-sourced active-version cache can be dropped after the rotation swap. */
type InvalidatableKeyProvider = KeyProvider & { invalidateActiveVersion?: () => void };

export interface RotateKeyDeps {
  /** App+key-admin capable pool: advisory lock, key_versions/kek_versions/events. */
  pool: Pool;
  /** DB-B owner pool — raw_transcripts + token_vault re-encryption (ADR 0008 Move 2). */
  rawPool: Pool;
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
  /** Injectable delay for the post-destroy settle-wait (real setTimeout by default; tests stub it). */
  sleep?: (ms: number) => Promise<void>;
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
 * failure) → pause + drain the queue → re-encrypt raw+vault old→new → verify no recoverable
 * old-version ciphertext → ONE tx {retire old, activate new, mark destroy-requested} → `destroyDek(old)`
 * → (inline finalize if window=0) → release. With a zero recovery window the finalizer runs inline;
 * otherwise Phase B (`confirm-destruction`) finalizes after the window.
 *
 * The active-swap is DEFERRED until after the sweep and committed atomically with the
 * destroy-request, so any crash mid-rotation leaves a resumable `rotating` state (re-run resumes) or,
 * after that commit, a `confirm-destruction`-pending state — never a retired-but-un-swept old version
 * whose rows a re-run would orphan. (A crash in the tiny gap between that commit and `destroyDek` is
 * self-healing: `confirm-destruction` idempotently re-issues `destroyDek` before checking
 * recoverability.) The queue stays paused through the destroy-request AND a settle-wait
 * (`KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS`, >= the active-version cache TTL), so no worker resumes
 * with a stale active-version cache and writes fresh ciphertext under the doomed key. Refuses to
 * start while a prior destruction is unfinished.
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
  const settleMs = deps.config.KEY_ROTATION_ACTIVE_VERSION_SETTLE_MS;

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
      return await runRotation(client, deps, { now, batch, windowDays, settleMs, justification });
    } catch (err) {
      // Sanitized audit of the abort; the CLI maps KeyLifecycleError → the §4 alert.
      await insertLifecycleEvent(client, { event: 'rotate_failed', actor: deps.actor }).catch(
        () => undefined,
      );
      throw err;
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [RETENTION_ADVISORY_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

async function runRotation(
  client: PoolClient,
  deps: RotateKeyDeps,
  ctx: {
    now: () => Date;
    batch: number;
    windowDays: number;
    settleMs: number;
    justification: string;
  },
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

  // Pause + drain, then re-encrypt with the OLD version STILL active. The active-swap is deferred
  // to the end (committed atomically with the destroy-request) so that any crash mid-rotation leaves
  // a resumable `rotating` state — never a retired-but-un-swept old version whose rows a re-run would
  // orphan (rotating the new key instead of finishing the old). The queue stays paused through the
  // swap + destroy-request, so it never resumes before the old key is being destroyed (which would
  // let a worker with a stale active-version cache write fresh ciphertext under the doomed key).
  await deps.maintenance.begin();
  let rowsReencrypted: number;
  let finalizedInline = false;
  const recoveryWindowUntil = new Date(ctx.now().getTime() + ctx.windowDays * 24 * 60 * 60 * 1000);
  try {
    const drained = await deps.maintenance.waitForDrain();
    if (!drained) {
      throw new KeyLifecycleError(
        'KEY_ROTATION_FAILED',
        'rotateKey: in-flight jobs did not drain within KEY_ROTATION_DRAIN_TIMEOUT_MS',
      );
    }
    const rawN = await reencryptRawTranscripts(deps.rawPool, {
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

    // Verify: no recoverable ciphertext left at the old version, BEFORE we commit the swap/destroy.
    const counts = await countRecoverableAtVersion(deps.rawPool, deps.restrictedRunner, oldVersion);
    if (counts.total > 0) {
      throw new KeyLifecycleError(
        'KEY_ROTATION_FAILED',
        `rotateKey: verify found ${counts.total} recoverable rows still at key_version ${oldVersion}`,
      );
    }

    // Atomic active-swap + Phase A destroy-request in ONE transaction (retire old FIRST so the
    // single-active index is never transiently violated). The store `destroyDek` runs AFTER this
    // commit — never before, or a rolled-back swap would leave the still-active key's material
    // pending-deleted.
    await client.query('BEGIN');
    try {
      await updateStatus(client, oldVersion, { from: 'active', to: 'retired' });
      await updateStatus(client, newVersion, { from: 'rotating', to: 'active' });
      await markDestroyRequested(client, oldVersion, {
        recoveryWindowUntil,
        approvalRef: ctx.justification,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    deps.keyProvider.invalidateActiveVersion?.();
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

    // Zero window → finalize inline under the lock we already hold, still before the queue resumes.
    if (ctx.windowDays === 0) {
      await finalizeUnderLock(client, {
        pool: deps.pool,
        keyStore: deps.keyStore,
        actor: deps.actor,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      finalizedInline = true;
    }

    // Settle-wait BEFORE resuming: stay paused long enough for every worker's active-version cache
    // to expire, so none resumes with a stale active version and writes fresh ciphertext under the
    // just-retired/destroy-requested key (which would be crypto-shredded when its window elapses).
    if (ctx.settleMs > 0) {
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await sleep(ctx.settleMs);
    }
  } finally {
    await deps.maintenance.end();
  }

  return { oldVersion, newVersion, rowsReencrypted, recoveryWindowUntil, finalizedInline };
}
