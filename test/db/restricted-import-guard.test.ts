import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two restricted tables must only be reached through the restricted repositories, so
 * their access stays isolated and auditable. This scans `src/db/` for SQL usage of the
 * table identifiers and fails if any file OUTSIDE the allowlist issues such a query.
 *
 * Deliberately precise: it matches the snake_case identifier only in a SQL clause
 * (FROM/INTO/UPDATE/JOIN/TABLE token_vault|match_keys), so PascalCase type names
 * (TokenVaultRow, MatchKeyRow) and doc-comment mentions elsewhere are allowed. No live
 * DB needed.
 */
const DB_DIR = fileURLToPath(new URL('../../src/db/', import.meta.url));

const ALLOWLIST = new Set([
  'restricted/token-vault-repo.ts',
  'restricted/match-keys-repo.ts',
  'restricted/restricted-context.ts',
]);

const SQL_USAGE = /\b(?:from|into|update|join|table)\s+(?:token_vault|match_keys)\b/i;

describe('restricted-table access guard', () => {
  it('token_vault / match_keys are queried only under src/db/restricted/', () => {
    const files = readdirSync(DB_DIR, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const offenders = files.filter((rel) => {
      const relPosix = rel.split(sep).join('/');
      if (ALLOWLIST.has(relPosix)) return false;
      return SQL_USAGE.test(readFileSync(join(DB_DIR, rel), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });
});
