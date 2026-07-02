import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { recordAlert } from '../db/repositories/alert-events-repo.js';
import {
  createDialpadClient,
  DialpadError,
  RedisDualWindowLimiter,
} from '../dialpad/client/index.js';
import {
  type ErrorCode,
  type ProcessingState,
  createFailure,
  dedupKey,
} from '../failure-model/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createPipelineQueue } from '../queue/pipeline-queue.js';
import {
  createPgReconciliationIngest,
  requireReconciliationCheckUrl,
  runReconciliation,
} from '../reconciliation/run.js';

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
 * Reconciliation-cron entrypoint (Task 3.4). A short-lived Railway cron (every 15 min UTC):
 * boots, sweeps the lookback window for calls the webhook missed, seeds + enqueues the gaps,
 * pings its own external check, releases every resource, and exits 0. Any failure exits
 * non-zero WITHOUT pinging, so the dead-man's switch fires. Never resident, never a worker.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'reconciliation-cron' });
  // Production must not run an unmonitored backstop: fail fast, naming the variable.
  requireReconciliationCheckUrl(config);
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

  try {
    await runReconciliation({
      config,
      logger,
      client,
      ...createPgReconciliationIngest({ pool, queue, config }),
    });
  } catch (err) {
    // Shared failure model: map a typed Dialpad failure to its stable code, persist the
    // deduped alert (best-effort — the DB may itself be the problem), log the structured
    // failure, then rethrow so the process exits non-zero. Never swallowed to stay green.
    if (err instanceof DialpadError && err.kind !== 'unavailable') {
      const mapped = KIND_TO_FAILURE[err.kind];
      const failure = createFailure(mapped.code, {
        processingState: mapped.processingState,
        context: { component: 'reconciliation-cron', environment: config.NODE_ENV },
      });
      try {
        await recordAlert(pool, {
          errorCode: failure.error_code,
          rootCauseCategory: failure.root_cause_category,
          severity: failure.severity,
          dedupKey: dedupKey(failure),
          failureSnapshot: {
            component: 'reconciliation-cron',
            status: err.status ?? null,
            attempts: err.attempts,
          },
        });
      } catch (alertErr) {
        logger.error(
          { error_code: failure.error_code },
          `alert persist failed: ${String(alertErr)}`,
        );
      }
      logger.fatal(
        {
          error_code: failure.error_code,
          root_cause_category: failure.root_cause_category,
          severity: failure.severity,
          processing_state: failure.processing_state,
          remediation_now: failure.remediation_now,
        },
        'reconciliation sweep failed',
      );
    }
    throw err;
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
