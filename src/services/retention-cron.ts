import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { Config } from '../config/schema.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { requireCheckUrl, type HeartbeatPinger } from '../heartbeat/index.js';
import { createFailure } from '../failure-model/index.js';
import { type AlertWebhookPoster, emitAlert, httpPostAlert } from '../alerting/index.js';
import { runRetention } from '../retention/run.js';
import { type PurgeReport, RetentionPurgeError, runPurge } from '../retention/purge.js';

/**
 * Pull the sanitized, PII-free diagnostic off a thrown purge error for the alert/log context.
 * A {@link RetentionPurgeError} carries `{ group, table, action, dry_run, sqlstate }`; anything
 * else yields nothing. All values are strings/scalars (never row content).
 */
function sanitizedPurgeCtx(err: unknown): Record<string, string> {
  if (!(err instanceof RetentionPurgeError)) return {};
  const c = err.context;
  return {
    group: c.group,
    table: c.table,
    action: c.action,
    dry_run: String(c.dry_run),
    ...(c.sqlstate ? { sqlstate: c.sqlstate } : {}),
  };
}

export interface RetentionServiceDeps {
  config: Config;
  logger: Logger;
  /** Pool bound to `purge_role` — runs the purge work. */
  purgePool: Pool;
  /** Pool bound to `app_role` — writes `alert_events` (purge_role must not touch it). */
  appPool: Pool;
  /** Injectable purge (defaults to {@link runPurge} over `purgePool`). */
  purge?: () => Promise<PurgeReport>;
  /** Dead-man's-switch ping (defaults inside runRetention to a timed HTTP GET). */
  pingCheck?: HeartbeatPinger;
  /** Outbound alert poster (defaults to the real HTTP POST; no-ops without ALERT_WEBHOOK_URL). */
  post?: AlertWebhookPoster;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/**
 * One retention-cron run body (Task 8.1). Runs the purge via the ping-on-success contract; on any
 * purge failure it records ONE actionable `RETENTION_PURGE_FAILED` alert on the **app_role** pool
 * (purge_role cannot write `alert_events`), logs the full failure fields + the sanitized purge
 * diagnostic (`group/table/action/dry_run/sqlstate`), and RETHROWS so the run exits non-zero
 * WITHOUT pinging — the missed external check is the primary signal, and the reconciliation cron's
 * delivery sweep ships the recorded alert. `emitAlert` is best-effort/never-throws, so a DB/webhook
 * problem cannot mask the original error.
 */
export async function runRetentionService(deps: RetentionServiceDeps): Promise<void> {
  const { config, logger, purgePool, appPool } = deps;
  const now = deps.now ?? ((): Date => new Date());

  try {
    await runRetention({
      config,
      logger,
      purge:
        deps.purge ??
        ((): Promise<PurgeReport> => runPurge({ pool: purgePool, config, logger, now: now() })),
      ...(deps.pingCheck ? { pingCheck: deps.pingCheck } : {}),
    });
  } catch (err) {
    const ctx = {
      component: 'retention-cron',
      environment: config.NODE_ENV,
      ...sanitizedPurgeCtx(err),
    };
    const failure = createFailure('RETENTION_PURGE_FAILED', {
      processingState: 'degraded',
      context: ctx,
    });
    await emitAlert(
      appPool,
      config,
      { code: 'RETENTION_PURGE_FAILED', processingState: 'degraded', context: ctx },
      { now: now(), logger, post: deps.post ?? httpPostAlert() },
    );
    logger.fatal(
      {
        error_code: failure.error_code,
        root_cause_category: failure.root_cause_category,
        severity: failure.severity,
        processing_state: failure.processing_state,
        remediation_now: failure.remediation_now,
        ...ctx,
      },
      'retention purge failed',
    );
    throw err;
  }
}

/**
 * Retention cron entrypoint. A short-lived Railway cron (daily, UTC): boots, confirms
 * dependencies, runs the purge as `purge_role`, pings its OWN external check only on a successful
 * run, and exits so Railway re-invokes on schedule. Any failure exits non-zero WITHOUT pinging.
 * Deletion never runs in the per-call path. No keepAlive — the cron must exit.
 *
 * Two pools: `purge_role` for all purge work (column-scoped least privilege) and `app_role` only
 * for the alert mirror (purge_role cannot write `alert_events`). No `requireAlertWebhookUrl` here —
 * the missed heartbeat is authoritative and the reconciliation cron delivers the recorded alert.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'retention-cron' });
  // Production/staging must not run an unmonitored purge cron: fail fast, naming the variable.
  requireCheckUrl(config, 'retention-cron');
  await assertDependenciesReady(config, logger);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const purgePool = createAppPool(config.DATABASE_URL, 'purge_role');
  const appPool = createAppPool(config.DATABASE_URL);
  try {
    await runRetentionService({ config, logger, purgePool, appPool });
  } finally {
    await purgePool.end();
    await appPool.end();
  }
}

// Auto-run only as the cron entrypoint, never when a test imports runRetentionService.
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    // Only the error CLASS, never its message: a raw pg error can carry row data (DETAIL/WHERE)
    // and must never reach a log line. The sanitized failure fields already went to the fatal
    // log + the RETENTION_PURGE_FAILED alert inside runRetentionService.
    const name = err instanceof Error ? err.name : 'unknown error';
    process.stderr.write(`retention-cron crashed (${name}); see the structured log / alert\n`);
    process.exit(1);
  });
}
