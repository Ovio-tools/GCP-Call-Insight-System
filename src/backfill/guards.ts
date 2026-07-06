import type { Config } from '../config/schema.js';
import { BackfillError } from './errors.js';

/**
 * The two backfill processing modes (Task 11.2, §1):
 *  - `production-real`     — seed + enqueue onto the shared pipeline queue; the worker fleet runs
 *    the full `runPipeline`. The ONLY mode that touches real Dialpad data, and only in production.
 *  - `staging-synthetic`   — seed + run `runPipeline` in-process against a fixture-backed Dialpad
 *    client; NO shared queue is ever constructed. The only mode allowed in staging.
 */
export type BackfillMode = 'production-real' | 'staging-synthetic';

/**
 * Environment guard (R3 #1): real historical backfill is PRODUCTION-ONLY; staging is limited to
 * synthetic-fixture smoke runs; dev/test are refused outright. PURE — no connections — so it runs
 * before any Dialpad/Redis/pipeline dependency is built.
 *
 *  - `development`/`test`         → refuse `not_live_environment`.
 *  - `staging` without a fixture  → refuse `staging_requires_synthetic` (staging is synthetic-only).
 *  - `staging` WITH a fixture     → `staging-synthetic`.
 *  - `production` WITH a fixture  → refuse `production_no_synthetic` (production is real data only).
 *  - `production` without a fixture → `production-real`.
 *
 * There is no host screen — the §0.2 consent gates are the real-data guard (checked separately,
 * before any fetch/enqueue). Returns the resolved {@link BackfillMode}.
 */
export function assertBackfillEnvironment(
  config: Config,
  opts: { syntheticDialpadFixture?: string },
): BackfillMode {
  const env = config.NODE_ENV;
  const hasFixture = opts.syntheticDialpadFixture !== undefined;

  if (env === 'development' || env === 'test') {
    throw new BackfillError(
      'not_live_environment',
      `refusing to run: backfill is production-only (staging is synthetic-only); NODE_ENV is ${env}`,
      { node_env: env },
    );
  }

  if (env === 'staging') {
    if (!hasFixture) {
      throw new BackfillError(
        'staging_requires_synthetic',
        'refusing to run: staging backfill requires --synthetic-dialpad-fixture (no real Dialpad data in staging)',
        { node_env: env },
      );
    }
    return 'staging-synthetic';
  }

  // production
  if (hasFixture) {
    throw new BackfillError(
      'production_no_synthetic',
      'refusing to run: production backfill processes real data — a synthetic fixture is not allowed',
      { node_env: env },
    );
  }
  return 'production-real';
}
