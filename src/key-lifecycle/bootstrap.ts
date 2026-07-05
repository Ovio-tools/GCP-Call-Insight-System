import type { Queryable } from '../db/types.js';
import type { KeyStore } from '../crypto/key-store.js';
import { query } from '../db/sql.js';
import { insertKek } from '../db/repositories/kek-versions-repo.js';
import { insertKeyVersion, allocateNextKeyVersion } from '../db/repositories/key-versions-repo.js';
import { insertLifecycleEvent } from '../db/repositories/key-lifecycle-events-repo.js';

export interface BootstrapKeyArgs {
  db: Queryable;
  keyStore: KeyStore;
  /** The first KEK version to create + activate (bootstrap/seed; thereafter DB-sourced). */
  kekVersion: string;
  actor: string;
  /** One of these is REQUIRED — the human justification, persisted in the bootstrap event. */
  approvalRef?: string;
  reason?: string;
  /** Override the first key_version (defaults to allocate MAX+1, normally 1 on a clean DB). */
  keyVersion?: number;
}

export interface BootstrapKeyResult {
  kekVersion: string;
  keyVersion: number;
}

/**
 * One-time bootstrap of the key hierarchy: create the FIRST active KEK + active DEK before any
 * service encrypts. Refuses to run twice — if an active KEK or key_version already exists it throws
 * rather than minting a second active key (which the single-active indexes would reject anyway).
 * Requires an actor and either an approval ref or a reason, both recorded in the `key_bootstrapped`
 * event. The caller wraps this in a transaction (so the KEK + DEK + event commit atomically).
 */
export async function bootstrapKey(args: BootstrapKeyArgs): Promise<BootstrapKeyResult> {
  if (!args.actor || args.actor.trim() === '') {
    throw new Error('bootstrapKey: --actor is required');
  }
  const justification = args.approvalRef ?? args.reason;
  if (!justification || justification.trim() === '') {
    throw new Error('bootstrapKey: either --approval-ref or --reason is required');
  }

  const activeKek = await query<{ n: number }>(
    args.db,
    `SELECT count(*)::int AS n FROM kek_versions WHERE status = 'active'`,
  );
  const activeDek = await query<{ n: number }>(
    args.db,
    `SELECT count(*)::int AS n FROM key_versions WHERE status = 'active'`,
  );
  if (activeKek[0]!.n > 0 || activeDek[0]!.n > 0) {
    throw new Error('bootstrapKey: an active key already exists — the DB is already bootstrapped');
  }

  const keyVersion = args.keyVersion ?? (await allocateNextKeyVersion(args.db));

  // External material first (KEK, then DEK wrapped by it), then durable metadata. If the DEK
  // creation or any metadata write fails, destroy the just-created external material so a failed
  // bootstrap never strands a KEK/DEK with no DB lifecycle record.
  const { kekRef } = await args.keyStore.createKek({ kekVersion: args.kekVersion });
  try {
    const { wrappedRef } = await args.keyStore.createDek({
      keyVersion,
      kekVersion: args.kekVersion,
    });

    await insertKek(args.db, {
      kekVersion: args.kekVersion,
      externalKekRef: kekRef,
      status: 'active',
    });
    await insertKeyVersion(args.db, {
      keyVersion,
      status: 'active',
      wrappedDekRef: wrappedRef,
      kekVersion: args.kekVersion,
    });
    await insertLifecycleEvent(args.db, {
      event: 'key_bootstrapped',
      keyVersion,
      kekVersion: args.kekVersion,
      actor: args.actor,
      approvalRef: justification,
    });

    return { kekVersion: args.kekVersion, keyVersion };
  } catch (err) {
    await args.keyStore.destroyDek(keyVersion).catch(() => undefined);
    await args.keyStore.destroyKek(args.kekVersion).catch(() => undefined);
    throw err;
  }
}
