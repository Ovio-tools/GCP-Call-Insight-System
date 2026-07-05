import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type KekVersionInsert,
  type KekVersionRow,
  kekVersionInsertSchema,
  kekVersionRowSchema,
} from '../schemas/kek-versions.js';

const TABLE = 'kek_versions';

/**
 * kek_versions repository (Task 8.2) — durable authoritative KEK state. `external_kek_ref` is an
 * external-store pointer, never key bytes. Mirrors key-versions-repo's fail-loud single-active
 * discipline: a partial unique index enforces one `status='active'` KEK and `getActiveKek` throws
 * on zero/multiple.
 */

/** The single active KEK version. Throws on zero (bootstrap needed) or multiple (corruption). */
export async function getActiveKek(db: Queryable): Promise<string> {
  const rows = await query<{ kek_version: string }>(
    db,
    `SELECT kek_version FROM kek_versions WHERE status = 'active'`,
  );
  if (rows.length === 0) {
    throw new Error('kek_versions: no active KEK — bootstrap a KEK before encrypting');
  }
  if (rows.length > 1) {
    throw new Error(
      `kek_versions: ${rows.length} active KEKs found; exactly one active KEK is required`,
    );
  }
  return rows[0]!.kek_version;
}

export async function insertKek(db: Queryable, input: KekVersionInsert): Promise<KekVersionRow> {
  const v = parseOrThrow(TABLE, kekVersionInsertSchema, input);
  const rows = await query<KekVersionRow>(
    db,
    `INSERT INTO kek_versions (kek_version, status, external_kek_ref)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [v.kekVersion, v.status, v.externalKekRef],
  );
  return parseOrThrow(TABLE, kekVersionRowSchema, rows[0]);
}

/** Guarded KEK status transition (e.g. `active → retired` on rekey). */
export async function updateKekStatus(
  db: Queryable,
  kekVersion: string,
  transition: { from: KekVersionRow['status']; to: KekVersionRow['status'] },
): Promise<void> {
  const rows = await query<{ kek_version: string }>(
    db,
    `UPDATE kek_versions SET status = $3 WHERE kek_version = $1 AND status = $2 RETURNING kek_version`,
    [kekVersion, transition.from, transition.to],
  );
  if (rows.length !== 1) {
    throw new Error(
      `kek_versions: transition ${transition.from}->${transition.to} for ${kekVersion} matched no row`,
    );
  }
}

/** Phase A: stamp the KEK destroy request + recovery window + approval ref (status stays `retired`). */
export async function markKekDestroyRequested(
  db: Queryable,
  kekVersion: string,
  args: { recoveryWindowUntil: Date; approvalRef: string },
): Promise<void> {
  const rows = await query<{ kek_version: string }>(
    db,
    `UPDATE kek_versions
        SET destroy_requested_at = now(),
            destroy_recovery_window_until = $2,
            destroy_approval_ref = $3
      WHERE kek_version = $1 AND status = 'retired' AND destroyed_at IS NULL
      RETURNING kek_version`,
    [kekVersion, args.recoveryWindowUntil, args.approvalRef],
  );
  if (rows.length !== 1) {
    throw new Error(
      `kek_versions: markKekDestroyRequested for ${kekVersion} matched no retired, not-yet-destroyed KEK`,
    );
  }
}

/** Phase B: flip `retired → destroyed` + stamp destroyed_at. Refuses a never-requested KEK. */
export async function markKekDestroyed(db: Queryable, kekVersion: string): Promise<void> {
  const rows = await query<{ kek_version: string }>(
    db,
    `UPDATE kek_versions
        SET status = 'destroyed', destroyed_at = now()
      WHERE kek_version = $1 AND status = 'retired' AND destroy_requested_at IS NOT NULL
      RETURNING kek_version`,
    [kekVersion],
  );
  if (rows.length !== 1) {
    throw new Error(
      `kek_versions: markKekDestroyed for ${kekVersion} matched no retired, destroy-requested KEK`,
    );
  }
}

/** Every KEK row (launch-gate + operator inspection). */
export async function listKekVersions(db: Queryable): Promise<KekVersionRow[]> {
  const rows = await query<KekVersionRow>(db, `SELECT * FROM kek_versions ORDER BY created_at`);
  return rows.map((r) => parseOrThrow(TABLE, kekVersionRowSchema, r));
}
