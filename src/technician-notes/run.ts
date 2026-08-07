import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { listNoteCandidateCallIds } from '../db/repositories/technician-notes-repo.js';
import { query } from '../db/sql.js';
import type { BackfillMonitor } from '../heartbeat/backfill-monitor.js';
import { TechnicianNoteError } from './errors.js';
import type { NoteGenerationResult, TechnicianNoteGenerator } from './generate.js';
import { TECHNICIAN_NOTE_PROMPT_VERSION } from './prompt.js';

/**
 * The technician-note batch runner (ADR 0009).
 *
 * Reuses the backfill JOB CONTRACT — one start ping, periodic progress pings, exactly one
 * terminal ping — but deliberately NOT the `backfill_runs` table: that table is keyed by a time
 * window with no job-kind discriminator, so a note run would collide with a real backfill on the
 * same window. There is no checkpoint and no `--resume` because none is needed: a re-run skips
 * every call that already has a note at the current prompt version, which makes the whole job
 * naturally resumable by simply running it again.
 *
 * Like `runBackfill` the orchestrator imports nothing environmental — no alerting module, no
 * pinger, no Anthropic client. Every side effect arrives as an injected dependency, so the run
 * logic is testable without a network or a monitor.
 */

/** DISTINCT from retention (8_100_001) and backfill (8_100_002) so the three never contend. */
export const TECHNICIAN_NOTES_ADVISORY_LOCK_KEY = 8_100_003;

export interface TechnicianNoteRunSummary {
  /** Candidates seen this run (after the prompt-version skip filter, unless --regenerate). */
  eligible: number;
  /** Calls a model call was actually attempted for. */
  attempted: number;
  generated: number;
  /** Eligible calls with no readable clean transcript (absent, soft-deleted, or hard-deleted). */
  skippedNoTranscript: number;
  failedSchema: number;
  failedModel: number;
  /** Notes whose residual scan nulled at least one field. */
  residualNullings: number;
  /** True when the run stopped early because the daily model cost cap was reached. */
  pausedOnCostCap: boolean;
  dryRun: boolean;
}

export interface RunTechnicianNotesDeps {
  pool: Pool;
  config: Config;
  logger: Logger;
  /** The per-call generator. Never constructed on a dry run. */
  generate: TechnicianNoteGenerator;
  /** The four-signal job monitor. Absent on a dry run — a preview is not a run. */
  monitor?: BackfillMonitor;
  /** Record the ONE TECHNICIAN_NOTE_RUN_DEGRADED alert when the failure rate crosses. */
  emitDegradedAlert: (context: Record<string, string>) => Promise<void>;
  /** `--regenerate`: rewrite notes that already exist at the current prompt version. */
  regenerate?: boolean;
  /** `--dry-run`: count only. Zero model calls, zero writes, zero pings. */
  dryRun?: boolean;
  /** `--limit <n>`: stop after this many eligible calls (a bounded first run). */
  limit?: number;
}

export async function runTechnicianNotes(
  deps: RunTechnicianNotesDeps,
): Promise<TechnicianNoteRunSummary> {
  const { pool, config, logger, generate, emitDegradedAlert } = deps;
  const regenerate = deps.regenerate ?? false;
  const dryRun = deps.dryRun ?? false;

  // 1. Kill switch: a RUN-level refusal, before any lock or ping. A batch job has no queue to
  //    recover parked calls from, so parking per call would be dead bookkeeping — re-running
  //    after enabling regenerates whatever is missing.
  if (!config.TECHNICIAN_NOTES_ENABLED) {
    throw new TechnicianNoteError(
      'disabled',
      'TECHNICIAN_NOTES_ENABLED is false — the technician-note job refuses to run',
    );
  }

  const summary: TechnicianNoteRunSummary = {
    eligible: 0,
    attempted: 0,
    generated: 0,
    skippedNoTranscript: 0,
    failedSchema: 0,
    failedModel: 0,
    residualNullings: 0,
    pausedOnCostCap: false,
    dryRun,
  };

  // 2. Advisory lock on a DEDICATED client, so two overlapping runs cannot double-spend the
  //    model budget on the same calls. Contention refuses without a start ping.
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const held = await query<{ locked: boolean }>(
      lockClient,
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [TECHNICIAN_NOTES_ADVISORY_LOCK_KEY],
    );
    locked = held[0]?.locked === true;
    if (!locked) {
      throw new TechnicianNoteError(
        'already_running',
        'another technician-note run holds the advisory lock',
      );
    }

    // A dry run takes NO pings, even if a monitor was handed in: a preview is not a run, and a
    // success ping for work that never happened would keep the external check green on a
    // schedule that is only ever previewing.
    const monitor = dryRun ? undefined : deps.monitor;

    await monitor?.start();

    try {
      let cursor: string | undefined;
      const limit = deps.limit;

      pages: for (;;) {
        const remaining =
          limit === undefined ? config.TECHNICIAN_NOTES_BATCH_SIZE : limit - summary.eligible;
        if (remaining <= 0) break;
        const pageSize = Math.min(config.TECHNICIAN_NOTES_BATCH_SIZE, remaining);

        const callIds = await listNoteCandidateCallIds(pool, {
          promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
          regenerate,
          limit: pageSize,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (callIds.length === 0) break;

        for (const callId of callIds) {
          summary.eligible += 1;

          if (dryRun) {
            // SELECT-only probe: the same readability rule the generator applies, with no model
            // call and no write of any kind.
            const transcript = await getCleanTranscript(pool, callId);
            if (!transcript) summary.skippedNoTranscript += 1;
            continue;
          }

          const result: NoteGenerationResult = await generate(callId);
          switch (result.outcome) {
            case 'generated':
              summary.attempted += 1;
              summary.generated += 1;
              if (result.residualCounts !== undefined) summary.residualNullings += 1;
              break;
            case 'skipped_no_transcript':
              summary.skippedNoTranscript += 1;
              break;
            case 'failed_schema':
              summary.attempted += 1;
              summary.failedSchema += 1;
              break;
            case 'failed_model':
              summary.attempted += 1;
              summary.failedModel += 1;
              break;
            case 'cost_cap':
              // PAUSE, not fail: the run ends cleanly and re-runs tomorrow. The generator
              // already emitted the deduped MODEL_COST_CAP_EXCEEDED alert, which is the
              // operator signal — a red monitor here would page someone over a budget cap.
              summary.pausedOnCostCap = true;
              break pages;
          }
        }

        monitor?.recordProgress({
          eligible: summary.eligible,
          generated: summary.generated,
          skipped: summary.skippedNoTranscript,
          failed: summary.failedSchema + summary.failedModel,
        });

        cursor = callIds[callIds.length - 1];
        if (callIds.length < pageSize) break;
      }

      // 3. Failure-rate alert. Gated on a minimum attempt count so a single failure in a tiny run
      //    cannot page anyone. Emitted AFTER the loop so it reflects the whole run, once.
      const failed = summary.failedSchema + summary.failedModel;
      if (
        summary.attempted >= config.TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS &&
        failed / summary.attempted > config.TECHNICIAN_NOTES_FAILURE_RATE_ALERT_THRESHOLD
      ) {
        await emitDegradedAlert({
          component: 'technician-notes',
          environment: config.NODE_ENV,
        });
        logger.warn(
          {
            component: 'technician-notes',
            attempted: summary.attempted,
            failed,
          },
          'technician-note run failure rate above threshold — degraded alert emitted',
        );
      }

      await monitor?.success();
    } catch (err) {
      // Any thrown error fails the monitor (idempotent) so the missed success ping is the alarm.
      await monitor?.fail();
      throw err;
    }

    logger.info(
      { component: 'technician-notes', ...summary },
      dryRun ? 'technician-note dry run finished' : 'technician-note run finished',
    );
    return summary;
  } finally {
    if (locked) {
      await query(lockClient, `SELECT pg_advisory_unlock($1)`, [
        TECHNICIAN_NOTES_ADVISORY_LOCK_KEY,
      ]).catch(() => undefined);
    }
    lockClient.release();
  }
}
