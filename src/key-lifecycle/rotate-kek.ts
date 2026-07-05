import type { Queryable } from '../db/types.js';
import type { KeyStore } from '../crypto/key-store.js';
import { getActiveKek, insertKek, updateKekStatus } from '../db/repositories/kek-versions-repo.js';
import { insertLifecycleEvent } from '../db/repositories/key-lifecycle-events-repo.js';

export interface RotateKekArgs {
  db: Queryable;
  keyStore: KeyStore;
  newKekVersion: string;
  actor: string;
  approvalRef?: string;
  reason?: string;
}

export interface RotateKekResult {
  oldKekVersion: string;
  newKekVersion: string;
}

/**
 * KEK activation / rekey (Task 8.2). Creates a new KEK in the store, then in one caller tx flips
 * the old KEK `active → retired` and the new one `→ active` (retire first, so the single-active
 * partial unique index is never transiently violated). New DEKs are created under the new KEK; the
 * RETIRED KEK stays usable for unwrapping its existing DEKs and is NOT destroyed until all DEKs
 * under it are destroyed. Rewrapping existing DEKs under the new KEK is deferred to Task 8.2b.
 */
export async function rotateKek(args: RotateKekArgs): Promise<RotateKekResult> {
  if (!args.actor || args.actor.trim() === '') {
    throw new Error('rotateKek: --actor is required');
  }
  const justification = args.approvalRef ?? args.reason;
  if (!justification || justification.trim() === '') {
    throw new Error('rotateKek: either --approval-ref or --reason is required');
  }

  const oldKekVersion = await getActiveKek(args.db);
  if (oldKekVersion === args.newKekVersion) {
    throw new Error(`rotateKek: ${args.newKekVersion} is already the active KEK`);
  }

  const { kekRef } = await args.keyStore.createKek({ kekVersion: args.newKekVersion });

  // Retire the old FIRST so the partial unique index never sees two actives.
  await updateKekStatus(args.db, oldKekVersion, { from: 'active', to: 'retired' });
  await insertKek(args.db, {
    kekVersion: args.newKekVersion,
    externalKekRef: kekRef,
    status: 'active',
  });
  await insertLifecycleEvent(args.db, {
    event: 'kek_rotated',
    kekVersion: args.newKekVersion,
    actor: args.actor,
    approvalRef: justification,
  });

  return { oldKekVersion, newKekVersion: args.newKekVersion };
}
