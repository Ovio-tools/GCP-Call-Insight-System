import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import type { Queryable } from '../types.js';
import {
  type KeyVersionInsert,
  type KeyVersionRow,
  keyVersionInsertSchema,
  keyVersionRowSchema,
} from '../schemas/key-versions.js';

const TABLE = 'key_versions';

/**
 * The single active key_version — the version new writes encrypt under. The keystore provider
 * (Task 8.2) reads this rather than a config value, so a rotation that flips the active row is
 * picked up without a redeploy. Fails LOUDLY on zero (bootstrap required) or multiple (corruption
 * the partial unique index should have prevented) active rows rather than guessing a version.
 */
export async function getActiveKeyVersion(db: Queryable): Promise<number> {
  const rows = await query<{ key_version: number }>(
    db,
    `SELECT key_version FROM key_versions WHERE status = 'active'`,
  );
  if (rows.length === 0) {
    throw new Error(
      'key_versions: no active key_version — bootstrap an active key before encrypting',
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `key_versions: ${rows.length} active key_versions found; exactly one active row is required`,
    );
  }
  return rows[0]!.key_version;
}

/** Insert DEK metadata (reference only — never key bytes). key_version is the PK. Accepts a pool
 * or a client so callers can enlist it in a bootstrap/rotation transaction. */
export async function insertKeyVersion(
  db: Queryable,
  input: KeyVersionInsert,
): Promise<KeyVersionRow> {
  const v = parseOrThrow(TABLE, keyVersionInsertSchema, input);
  const rows = await query<KeyVersionRow>(
    db,
    `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [v.keyVersion, v.status, v.wrappedDekRef, v.kekVersion],
  );
  return parseOrThrow(TABLE, keyVersionRowSchema, rows[0]);
}

export async function getKeyVersion(
  pool: Pool,
  keyVersion: number,
): Promise<KeyVersionRow | undefined> {
  const rows = await query<KeyVersionRow>(
    pool,
    `SELECT * FROM key_versions WHERE key_version = $1`,
    [keyVersion],
  );
  return rows[0] ? parseOrThrow(TABLE, keyVersionRowSchema, rows[0]) : undefined;
}

export async function listKeyVersions(pool: Pool): Promise<KeyVersionRow[]> {
  const rows = await query<KeyVersionRow>(pool, `SELECT * FROM key_versions ORDER BY key_version`);
  return rows.map((r) => parseOrThrow(TABLE, keyVersionRowSchema, r));
}

/**
 * Allocate the next key_version number WITHOUT inserting a row. Rotation calls this while it holds
 * the shared advisory lock (8_100_001), so `MAX+1` is race-free; the metadata row is inserted only
 * AFTER the external DEK is created (allocate → createDek → insert), so a crash never orphans a
 * key_versions row pointing at a DEK that doesn't exist.
 */
export async function allocateNextKeyVersion(db: Queryable): Promise<number> {
  const rows = await query<{ next: number }>(
    db,
    `SELECT COALESCE(MAX(key_version), 0) + 1 AS next FROM key_versions`,
  );
  return rows[0]!.next;
}

/** Insert the new version as `rotating` with its wrapped-DEK ref (post-createDek). */
export async function insertRotatingKeyVersion(
  db: Queryable,
  input: { keyVersion: number; wrappedDekRef: string; kekVersion: string },
): Promise<KeyVersionRow> {
  const v = parseOrThrow(TABLE, keyVersionInsertSchema, { ...input, status: 'rotating' });
  const rows = await query<KeyVersionRow>(
    db,
    `INSERT INTO key_versions (key_version, status, wrapped_dek_ref, kek_version)
     VALUES ($1, 'rotating', $2, $3)
     RETURNING *`,
    [v.keyVersion, v.wrappedDekRef, v.kekVersion],
  );
  return parseOrThrow(TABLE, keyVersionRowSchema, rows[0]);
}

/**
 * Guarded status transition: updates only if the row is currently `from`, else throws. The atomic
 * active-swap (old `active→retired`, new `rotating→active`) is two of these in one caller tx, with
 * the retire done FIRST so the single-active partial unique index is never transiently violated.
 */
export async function updateStatus(
  db: Queryable,
  keyVersion: number,
  transition: { from: KeyVersionRow['status']; to: KeyVersionRow['status'] },
): Promise<void> {
  const rows = await query<{ key_version: number }>(
    db,
    `UPDATE key_versions SET status = $3 WHERE key_version = $1 AND status = $2 RETURNING key_version`,
    [keyVersion, transition.from, transition.to],
  );
  if (rows.length !== 1) {
    throw new Error(
      `key_versions: transition ${transition.from}->${transition.to} for v${keyVersion} matched no row (precondition failed)`,
    );
  }
}

/** Phase A: stamp the destroy request + recovery window + approval ref (status stays `retired`). */
export async function markDestroyRequested(
  db: Queryable,
  keyVersion: number,
  args: { recoveryWindowUntil: Date; approvalRef: string },
): Promise<void> {
  const rows = await query<{ key_version: number }>(
    db,
    `UPDATE key_versions
        SET destroy_requested_at = now(),
            destroy_recovery_window_until = $2,
            destroy_approval_ref = $3
      WHERE key_version = $1 AND status = 'retired' AND destroyed_at IS NULL
      RETURNING key_version`,
    [keyVersion, args.recoveryWindowUntil, args.approvalRef],
  );
  if (rows.length !== 1) {
    throw new Error(
      `key_versions: markDestroyRequested for v${keyVersion} matched no retired, not-yet-destroyed row`,
    );
  }
}

/** Phase B: flip `retired → destroyed` + stamp destroyed_at. Refuses a never-requested version. */
export async function markDestroyed(db: Queryable, keyVersion: number): Promise<void> {
  const rows = await query<{ key_version: number }>(
    db,
    `UPDATE key_versions
        SET status = 'destroyed', destroyed_at = now()
      WHERE key_version = $1 AND status = 'retired' AND destroy_requested_at IS NOT NULL
      RETURNING key_version`,
    [keyVersion],
  );
  if (rows.length !== 1) {
    throw new Error(
      `key_versions: markDestroyed for v${keyVersion} matched no retired, destroy-requested row`,
    );
  }
}

/** Every version wrapped by a given KEK — the KEK-revocation blast radius. */
export async function listVersionsByKek(
  db: Queryable,
  kekVersion: string,
): Promise<KeyVersionRow[]> {
  const rows = await query<KeyVersionRow>(
    db,
    `SELECT * FROM key_versions WHERE kek_version = $1 ORDER BY key_version`,
    [kekVersion],
  );
  return rows.map((r) => parseOrThrow(TABLE, keyVersionRowSchema, r));
}
