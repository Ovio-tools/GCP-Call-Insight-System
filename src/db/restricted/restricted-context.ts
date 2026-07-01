import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../sql.js';

const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The single choke point for restricted-role access. `run(fn)` opens a transaction and
 * issues `SET LOCAL ROLE restricted_role` before invoking `fn`, so the vault / match-key
 * repositories execute with restricted privileges and the role reverts automatically at
 * COMMIT/ROLLBACK (a pooled connection can never leak elevated privilege). Every read or
 * write of `token_vault` / `match_keys` goes through here, which is what makes that
 * access auditable and isolated to the two `restricted/` repositories.
 */
export interface RestrictedRunner {
  run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export function createRestrictedRunner(pool: Pool, role = 'restricted_role'): RestrictedRunner {
  if (!ROLE_IDENTIFIER.test(role)) {
    throw new Error(`invalid role name: ${JSON.stringify(role)}`);
  }
  return {
    run(fn) {
      return withTransaction(pool, async (client) => {
        await client.query(`SET LOCAL ROLE ${role}`);
        return fn(client);
      });
    },
  };
}
