import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { recordHeartbeat } from '../db/repositories/component-heartbeats-repo.js';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import {
  createDialpadClient,
  DialpadError,
  RedisDualWindowLimiter,
} from '../dialpad/client/index.js';
import { type ErrorCode, type ProcessingState, createFailure } from '../failure-model/index.js';
import {
  emitAlert,
  escalateAndDeliver,
  httpPostAlert,
  requireAlertWebhookUrl,
  retryPendingDeliveries,
} from '../alerting/index.js';
import { httpPing } from '../heartbeat/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue, enqueueReprocess } from '../queue/pipeline-queue.js';
import {
  createPgReconciliationIngest,
  requireReconciliationCheckUrl,
  runReconciliation,
  runReconciliationCron,
} from '../reconciliation/run.js';
import { drainPendingReprocessRequests } from '../reconciliation/reprocess-drain.js';
import { scanStalledReviews } from '../review-queue/scan.js';
import { syncLabeledExamples } from '../evaluation/sync.js';
import { loadDenyList } from '../redaction/deny-list.js';

/** Same mapping the fetch-transcript stage uses; `unavailable` stays a plain transient
 * failure — the missed check ping (dead-man's switch) is its alert channel. */
const KIND_TO_FAILURE: Record<
  Exclude<DialpadError['kind'], 'unavailable'>,
  { code: ErrorCode; processingState: ProcessingState }
> = {
  auth: { code: 'DIALPAD_AUTH_FAILED', processingState: 'paused' },
  rate_limited: { code: 'DIALPAD_RATE_LIMITED', processingState: 'degraded' },
  api_changed: { code: 'DIALPAD_API_CHANGED', processingState: 'paused' },
};

/**
 * Best-effort, Postgres-gated alert maintenance piggybacked on the reconciliation cron (Task
 * 7.3): escalate unacknowledged criticals and deliver them, then retry any owed alert
 * deliveries. Run INDEPENDENTLY of the Dialpad sweep — deliberately BEFORE outbound Dialpad
 * work so it is attempted whether the sweep later succeeds or throws (a sweep failure is
 * exactly when stale criticals most need to escalate). Each step is wrapped so its own error
 * is caught + sanitized-logged and NEVER rethrown, so it can neither fail a successful
 * reconciliation nor mask the sweep's outcome. Needs only `pool`; if Postgres is unavailable
 * the steps throw internally and are swallowed here (the DB-unavailable alert path covers it).
 */
async function runAlertMaintenance(pool: Pool, config: Config, logger: Logger): Promise<void> {
  const deps = { now: new Date(), logger, post: httpPostAlert() };
  const windowMs = config.ALERT_ESCALATION_WINDOW_MINUTES * 60_000;
  try {
    await escalateAndDeliver(pool, config, { ...deps, windowMs });
  } catch (err) {
    logger.warn({ component: 'reconciliation-cron' }, `escalation step failed: ${String(err)}`);
  }
  try {
    await retryPendingDeliveries(pool, config, deps);
  } catch (err) {
    logger.warn({ component: 'reconciliation-cron' }, `alert retry sweep failed: ${String(err)}`);
  }
}

/**
 * Reconciliation-cron entrypoint (Task 3.4 + 6.1). A short-lived Railway cron (every 15 min UTC):
 * boots, then runs two independent duties — the metadata sweep AND the review-SLA-breach scan —
 * pings its own external check only when BOTH succeeded, releases every resource, and exits 0.
 * Any duty failure exits non-zero WITHOUT pinging, so the dead-man's switch fires. Never
 * resident, never a worker.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'reconciliation-cron' });
  // Production must not run an unmonitored backstop: fail fast, naming the variable.
  requireReconciliationCheckUrl(config);
  // This cron is also the alert-delivery/escalation runner: in prod it must have a delivery
  // channel or critical alerts would be silently undeliverable. Fail fast, naming the variable.
  requireAlertWebhookUrl(config);
  await assertDependenciesReady(config, logger);

  // Readiness guarantees DATABASE_URL/REDIS_URL are set and reachable; guard anyway for types.
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  // Separate Redis connections, as in the worker: the queue's commands must not stall
  // behind the outbound Dialpad rate limiter's evals.
  const queueConnection = createQueueConnectionFromConfig(config);
  const limiterConnection = createQueueConnectionFromConfig(config);
  const queue = createPipelineQueue(config, queueConnection);
  const limiter = new RedisDualWindowLimiter(limiterConnection, {
    perSecond: config.DIALPAD_RATE_PER_SECOND,
    perMinute: config.DIALPAD_RATE_PER_MINUTE,
  });
  const client = createDialpadClient({ config, limiter, logger });

  // Load the client deny-list ONCE (a set-but-unreadable path fails loud at boot, before the sweep);
  // reused by the label-sync duty's residual-PII gate. Absent path ⇒ empty deny list.
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  // Alert maintenance runs FIRST, gated only on Postgres and wrapped to never throw — so
  // stale-critical escalation and owed deliveries are attempted whether the Dialpad sweep
  // below succeeds or fails. It must precede the sweep because the sweep rethrows Dialpad
  // failures, and escalation is most needed exactly then.
  await runAlertMaintenance(pool, config, logger);

  try {
    await runReconciliationCron({
      config,
      logger,
      ping: httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
      runSweep: () =>
        runReconciliation({
          config,
          logger,
          client,
          // Best-effort in-DB liveness mirror for the status surface (Task 7.3). Counts only,
          // no PII. runReconciliation wraps this so a DB-write failure never fails the sweep.
          heartbeat: async (summary) => {
            await recordHeartbeat(pool, {
              component: 'reconciliation-cron',
              detail: { gaps_enqueued: summary.gapsEnqueued, calls_checked: summary.callsChecked },
            });
          },
          ...createPgReconciliationIngest({ pool, queue, config }),
        }),
      runScan: () => scanStalledReviews(pool, config, logger, new Date()),
      // Drain the reprocess-request outbox (Task 6.2): recover any reprocess stranded by a
      // crash/Redis outage between the review-action commit and its optimistic enqueue. An
      // incomplete drain withholds the ping (mirrors the scan's contract).
      runDrain: () =>
        drainPendingReprocessRequests(pool, {
          logger,
          enqueue: (row) => enqueueReprocess(queue, row.callId, config, row.reviewQueueId),
        }),
      // Health-gated label capture (Task 6.3): mine resolved review decisions into the labeled
      // corpus every 15 min so a correction is captured well inside the shortest CLEAN purge window.
      // A nonzero `SyncSummary.failed` (operational failure) or a throw withholds the ping.
      runLabelSync: async () => {
        const summary = await syncLabeledExamples(pool, { denyTerms, logger });
        return { failed: summary.failed };
      },
      onSweepError: async (err) => {
        // Shared failure model: map a typed Dialpad failure to its stable code, emit the deduped
        // alert AND attempt immediate delivery (emitAlert is best-effort — the DB/webhook may
        // itself be the problem — so it never throws), and log the structured failure. The ping
        // is withheld by the combined-health gate, so the process still exits non-zero.
        if (err instanceof DialpadError && err.kind !== 'unavailable') {
          const mapped = KIND_TO_FAILURE[err.kind];
          const failure = createFailure(mapped.code, {
            processingState: mapped.processingState,
            context: { component: 'reconciliation-cron', environment: config.NODE_ENV },
          });
          await emitAlert(
            pool,
            config,
            {
              code: mapped.code,
              processingState: mapped.processingState,
              context: { component: 'reconciliation-cron', environment: config.NODE_ENV },
            },
            { now: new Date(), logger, post: httpPostAlert() },
          );
          logger.fatal(
            {
              error_code: failure.error_code,
              root_cause_category: failure.root_cause_category,
              severity: failure.severity,
              processing_state: failure.processing_state,
              remediation_now: failure.remediation_now,
              // PII-free Dialpad diagnostics so a contract drift is pinpointable from one log line:
              // endpoint + HTTP status + the offending field path/reason (never a value).
              dialpad_endpoint: err.endpoint,
              dialpad_status: err.status,
              dialpad_detail: err.detail,
            },
            'reconciliation sweep failed',
          );
        } else {
          logger.error(
            { component: 'reconciliation-cron' },
            `reconciliation sweep failed: ${err instanceof Error ? err.name : typeof err}`,
          );
        }
      },
    });
  } finally {
    await queue.close();
    await queueConnection.quit();
    await limiterConnection.quit();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`reconciliation-cron failed: ${String(err)}\n`);
  process.exit(1);
});
