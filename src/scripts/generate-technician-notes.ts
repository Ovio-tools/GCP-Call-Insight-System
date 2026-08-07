import { pathToFileURL } from 'node:url';
import { createBootLogger } from '../boot/logger.js';
import { loadConfig } from '../config/index.js';
import { createAppPool } from '../db/index.js';
import { httpPostAlert, requireAlertWebhookUrl, emitAlert } from '../alerting/index.js';
import { createAnthropicTechnicianNoteClient } from '../anthropic/client.js';
import type { TechnicianNoteModelClient } from '../anthropic/client.js';
import {
  checkUrlFor,
  createBackfillMonitor,
  deriveJobSignalUrls,
  httpPing,
  requireCheckUrl,
  type BackfillMonitor,
  type IntervalScheduler,
} from '../heartbeat/index.js';
import { requireRedactionConfig } from '../redaction/config.js';
import {
  TechnicianNoteError,
  createTechnicianNoteGenerator,
  runTechnicianNotes,
} from '../technician-notes/index.js';

/**
 * Technician-note batch generator entrypoint (ADR 0009).
 *
 * Generates the job-readiness note a technician reads before a visit, from a call's STORED
 * REDACTED transcript. It is not a pipeline stage and never holds a call: a failure records the
 * outcome and moves on, because a review_queue hold would block the CLEAN retention purge and
 * silently extend PII retention for a cosmetic failure.
 *
 * Guard order (all BEFORE any pool, model client, or ping): loadConfig → requireRedactionConfig →
 * requireCheckUrl(technician-notes) → requireAlertWebhookUrl → connect app pool → build monitor +
 * generator → runTechnicianNotes.
 *
 * Usage:
 *   generate-technician-notes [--dry-run] [--regenerate] [--limit <n>]
 *
 *   --dry-run     count eligible / skipped-no-transcript / would-generate. Zero model calls,
 *                 zero writes, zero pings.
 *   --regenerate  rewrite notes that already exist at the current prompt version (the version
 *                 comparison the ADR 0009 feedback loop depends on).
 *   --limit <n>   stop after n eligible calls.
 */
interface NoteArgs {
  dryRun: boolean;
  regenerate: boolean;
  limit?: number;
}

export function parseArgs(argv: readonly string[]): NoteArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limitRaw = get('--limit');
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('--limit must be a positive integer');
    }
    limit = parsed;
  }
  return {
    dryRun: argv.includes('--dry-run'),
    regenerate: argv.includes('--regenerate'),
    ...(limit !== undefined ? { limit } : {}),
  };
}

const realScheduler: IntervalScheduler = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'generate-technician-notes' });

  // The deny list backs the residual scan over the model's own output — a missing/unreadable one
  // must fail the run, not silently weaken the scan.
  requireRedactionConfig(config);

  // A dry run makes no model calls and no writes, so it needs neither a monitor nor an alert sink.
  if (!args.dryRun) {
    requireCheckUrl(config, 'technician-notes');
    requireAlertWebhookUrl(config);
  }

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const pool = createAppPool(config.DATABASE_URL);

  let monitor: BackfillMonitor | undefined;
  try {
    const base = checkUrlFor(config, 'technician-notes');
    if (!args.dryRun && base !== undefined) {
      monitor = createBackfillMonitor({
        signals: deriveJobSignalUrls(base),
        component: 'technician-notes',
        ping: httpPing(config.HEARTBEAT_PING_TIMEOUT_MS),
        scheduler: realScheduler,
        now: () => Date.now(),
        logger,
        progressIntervalMs: config.TECHNICIAN_NOTES_PROGRESS_INTERVAL_MS,
        stallThresholdMs: config.TECHNICIAN_NOTES_STALL_THRESHOLD_MS,
      });
    }

    const emitDegradedAlert = async (context: Record<string, string>): Promise<void> => {
      await emitAlert(
        pool,
        config,
        { code: 'TECHNICIAN_NOTE_RUN_DEGRADED', processingState: 'degraded', context },
        { now: new Date(), logger, post: httpPostAlert() },
      );
    };

    // Lazily memoized: a dry run, or a run whose every candidate lacks a transcript, never
    // constructs the SDK client and so never needs ANTHROPIC_API_KEY.
    let model: TechnicianNoteModelClient | undefined;
    const getModel = (): TechnicianNoteModelClient => {
      model ??= createAnthropicTechnicianNoteClient(config);
      return model;
    };

    const generate = createTechnicianNoteGenerator({ pool, config, logger, getModel });

    await runTechnicianNotes({
      pool,
      config,
      logger,
      generate,
      ...(monitor !== undefined ? { monitor } : {}),
      emitDegradedAlert,
      regenerate: args.regenerate,
      dryRun: args.dryRun,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
  } finally {
    monitor?.stop();
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // Sanitized: error class / refusal reason only. A raw message could carry a connection
    // string, an SDK error body, or transcript content.
    const name =
      err instanceof TechnicianNoteError
        ? `TechnicianNoteError(${err.reason})`
        : err instanceof Error
          ? err.name
          : 'unknown error';
    process.stderr.write(
      `generate-technician-notes failed (${name}); see the structured log / alert\n`,
    );
    process.exit(1);
  });
}
