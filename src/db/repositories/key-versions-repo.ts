import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query } from '../sql.js';
import {
  type KeyVersionInsert,
  type KeyVersionRow,
  keyVersionInsertSchema,
  keyVersionRowSchema,
} from '../schemas/key-versions.js';

const TABLE = 'key_versions';

/** Insert DEK metadata (reference only — never key bytes). key_version is the PK. */
export async function insertKeyVersion(
  pool: Pool,
  input: KeyVersionInsert,
): Promise<KeyVersionRow> {
  const v = parseOrThrow(TABLE, keyVersionInsertSchema, input);
  const rows = await query<KeyVersionRow>(
    pool,
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
