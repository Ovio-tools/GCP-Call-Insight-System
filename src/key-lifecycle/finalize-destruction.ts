import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { KeyStore } from '../crypto/key-store.js';
import { query } from '../db/sql.js';
import { RETENTION_ADVISORY_LOCK_KEY } from '../retention/purge.js';
import { markDestroyed } from '../db/repositories/key-versions-repo.js';
import { markKekDestroyed } from '../db/repositories/kek-versions-repo.js';
import { insertLifecycleEvent } from '../db/repositories/key-lifecycle-events-repo.js';

export interface FinalizeDeps {
  /** Used only by the standalone {@link finalizeDestruction} to acquire the advisory-lock client. */
  pool: Pool;
  keyStore: KeyStore;
  actor: string;
  logger?: Logger;
}

export interface FinalizeResult {
  finalizedDeks: number[];
  finalizedKeks: string[];
  /** Versions/KEKs still inside their recovery window — skipped, to be finalized after it elapses. */
  pendingDeks: number[];
  pendingKeks: string[];
}

/**
 * Phase B (Task 8.2): confirm every requested-but-not-finalized destruction is truly unrecoverable
 * in the STORE (the second verification of the crypto-shred — `store.recoverability`, never the DB
 * flag), then flip `destroyed`. Resumable and idempotent — it picks up any `destroy_requested_at`-set
 * / `destroyed_at`-null DEK or KEK. A version still inside its recovery window
 * (`recoverability.recoverable === true`) is SKIPPED, not marked; the operator re-runs after the
 * window. (The "old version is empty" completeness check is rotation-specific and runs in `rotate.ts`
 * before the destroy request — it must NOT run here, since a REVOCATION deliberately leaves the
 * shredded rows in place at the destroyed version.) Assumes the caller holds the shared advisory lock
 * (`finalizeUnderLock`), or acquires it itself (`finalizeDestruction`).
 */
export async function finalizeUnderLock(
  client: PoolClient,
  deps: FinalizeDeps,
): Promise<FinalizeResult> {
  const out: FinalizeResult = {
    finalizedDeks: [],
    finalizedKeks: [],
    pendingDeks: [],
    pendingKeks: [],
  };

  const dekRows = await query<{ key_version: number }>(
    client,
    `SELECT key_version FROM key_versions
      WHERE destroy_requested_at IS NOT NULL AND destroyed_at IS NULL
      ORDER BY key_version`,
  );
  for (const { key_version: v } of dekRows) {
    const rec = await deps.keyStore.recoverability({ type: 'dek', keyVersion: v });
    if (rec.recoverable) {
      out.pendingDeks.push(v);
      continue;
    }
    await markDestroyed(client, v);
    await insertLifecycleEvent(client, {
      event: 'destroy_confirmed',
      keyVersion: v,
      actor: deps.actor,
    });
    out.finalizedDeks.push(v);
  }

  const kekRows = await query<{ kek_version: string }>(
    client,
    `SELECT kek_version FROM kek_versions
      WHERE destroy_requested_at IS NOT NULL AND destroyed_at IS NULL
      ORDER BY kek_version`,
  );
  for (const { kek_version: k } of kekRows) {
    const rec = await deps.keyStore.recoverability({ type: 'kek', kekVersion: k });
    if (rec.recoverable) {
      out.pendingKeks.push(k);
      continue;
    }
    await markKekDestroyed(client, k);
    await insertLifecycleEvent(client, {
      event: 'destroy_confirmed',
      kekVersion: k,
      actor: deps.actor,
    });
    out.finalizedKeks.push(k);
  }

  return out;
}

/** Standalone finalizer (confirm-destruction CLI): acquires the shared advisory lock itself. */
export async function finalizeDestruction(deps: FinalizeDeps): Promise<FinalizeResult> {
  const client = await deps.pool.connect();
  try {
    const locked = (
      await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        RETENTION_ADVISORY_LOCK_KEY,
      ])
    ).rows[0]?.ok;
    if (!locked) {
      throw new Error('finalizeDestruction: another rotation/retention run holds the advisory lock');
    }
    try {
      return await finalizeUnderLock(client, deps);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_ADVISORY_LOCK_KEY]).catch(
        () => undefined,
      );
    }
  } finally {
    client.release();
  }
}
