import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { HeldReason } from '../db/enums.js';
import type { JsonValue } from '../db/types.js';
import { query } from '../db/sql.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { getLatestModelInvocationForCallStageBefore } from '../db/repositories/model-invocations-repo.js';
import { insertLabeledExample } from '../db/repositories/labeled-examples-repo.js';
import { insertRejection } from '../db/repositories/labeled-example-rejections-repo.js';
import { CLASSIFY_PROMPT_VERSION } from '../pipeline/classify/prompt.js';
import { EXTRACT_PROMPT_VERSION, EXTRACT_SCHEMA_VERSION } from '../pipeline/extract/prompt.js';
import { type ExpectedOutput, type LabeledTaskType } from '../db/schemas/labeled-examples.js';
import { EVAL_SET_VERSION, PII_GATE_VERSION } from './version.js';
import { actionToLabelSpec, buildClassifyLabel, buildExtractLabel } from './labeled-example.js';
import { validateRedactedInputSafe } from './pii-gate.js';

/**
 * Mine resolved review decisions into the labeled corpus (Task 6.3). Derivation-only, idempotent,
 * and safe to re-run / interrupt / run concurrently (`ON CONFLICT DO NOTHING`, independent per row).
 * NEVER edits `src/review/actions.ts` — it reads the append-only `operator_actions` audit rows.
 *
 * Per candidate: derive the label spec (skip non-labels); pre-check the current-version accepted +
 * rejected sets (both must miss, so a gate/set bump re-opens both); load the clean transcript
 * (missing → content-free `missing_clean` rejection); look up model/prompt provenance; run the
 * extract schema gate and the residual-PII gate; write the accepted label or the content-free
 * rejection. Corrected outputs are controlled enums only; the transcript is the sole text path and
 * is already redaction-boundary clean — the PII gate is defense-in-depth over it.
 */

export interface SyncDeps {
  denyTerms: readonly string[];
  logger: Logger;
}

/**
 * Outcome tally. Expected per-candidate outcomes never fail the cron; only `failed` (an operational
 * failure) withholds the reconciliation heartbeat (findings R5-1, R5-2).
 */
export interface SyncSummary {
  accepted: number;
  rejected_pii: number;
  rejected_schema: number;
  missing_clean: number;
  already_present: number;
  failed: number;
}

interface CandidateRow {
  operator_action_id: string;
  action: string;
  actor: string;
  after: JsonValue | null;
  created_at: Date;
  review_queue_id: string;
  call_id: string;
  held_reason: HeldReason;
}

/** The label actions worth mining — everything else in `operator_actions` is not a label. */
const CANDIDATE_QUERY = `
  SELECT oa.id AS operator_action_id, oa.action, oa.actor, oa.after, oa.created_at,
         rq.id AS review_queue_id, rq.call_id, rq.held_reason
  FROM operator_actions oa
  JOIN review_queue rq ON rq.id = oa.review_queue_id
  WHERE oa.action IN ('approve', 'mark_non_customer', 'mark_spam', 'correct_extraction')
  ORDER BY oa.created_at`;

/** Max missing-clean call_ids logged per run (finding R5-2) — the rest live in the rejection rows. */
const MISSING_CLEAN_LOG_SAMPLE = 20;

/** True iff an accepted OR rejected row already exists for this candidate at the current versions. */
async function alreadyProcessed(
  pool: Pool,
  operatorActionId: string,
  taskType: LabeledTaskType,
): Promise<boolean> {
  const rows = await query(
    pool,
    `SELECT 1 FROM labeled_examples
       WHERE operator_action_id = $1 AND task_type = $2
         AND pii_gate_version = $3 AND eval_set_version = $4
     UNION ALL
     SELECT 1 FROM labeled_example_rejections
       WHERE operator_action_id = $1 AND task_type = $2
         AND pii_gate_version = $3 AND eval_set_version = $4
     LIMIT 1`,
    [operatorActionId, taskType, PII_GATE_VERSION, EVAL_SET_VERSION],
  );
  return rows.length > 0;
}

export async function syncLabeledExamples(pool: Pool, deps: SyncDeps): Promise<SyncSummary> {
  const { denyTerms, logger } = deps;
  const summary: SyncSummary = {
    accepted: 0,
    rejected_pii: 0,
    rejected_schema: 0,
    missing_clean: 0,
    already_present: 0,
    failed: 0,
  };
  const missingCleanCalls: string[] = [];

  // A candidate-query failure is an operational failure: let it propagate so the caller withholds
  // the heartbeat (the cron/service treats a throw exactly like nonzero `failed`).
  const candidates = await query<CandidateRow>(pool, CANDIDATE_QUERY);

  for (const row of candidates) {
    const spec = actionToLabelSpec(row.action, row.held_reason, row.after);
    if (spec === null) continue; // not a label (e.g. approve on a non-classifier_uncertain hold)

    // Each candidate is fully independent + idempotent. A per-row failure is counted as an
    // operational failure and does NOT abort the remaining candidates.
    try {
      if (await alreadyProcessed(pool, row.operator_action_id, spec.task_type)) {
        summary.already_present += 1;
        continue;
      }

      const clean = await getCleanTranscript(pool, row.call_id);
      if (clean === undefined) {
        // Terminal, content-free rejection — the clean transcript was purged/absent before capture.
        await insertRejection(pool, {
          operatorActionId: row.operator_action_id,
          taskType: spec.task_type,
          reviewQueueId: row.review_queue_id,
          callId: row.call_id,
          heldReason: row.held_reason,
          rejectionReason: 'missing_clean',
          rejectionCounts: null,
          evalSetVersion: EVAL_SET_VERSION,
          piiGateVersion: PII_GATE_VERSION,
        });
        summary.missing_clean += 1;
        missingCleanCalls.push(row.call_id);
        continue;
      }

      // Provenance: the latest same-stage invocation strictly before the action. When found, both
      // model_id and prompt version come from it; when none, model_id is NULL and the prompt version
      // falls back to the current stage constant. Never a fabricated id.
      const stage = spec.task_type === 'classify' ? 'classify' : 'extract';
      const invocation = await getLatestModelInvocationForCallStageBefore(pool, {
        callId: row.call_id,
        stage,
        before: row.created_at,
      });
      const currentConstant =
        spec.task_type === 'classify' ? CLASSIFY_PROMPT_VERSION : EXTRACT_PROMPT_VERSION;
      const provenance = invocation
        ? {
            modelId: invocation.model_id,
            modelIdSource: 'model_invocations' as const,
            sourcePromptVersion: invocation.prompt_version,
            promptVersionSource: 'model_invocations' as const,
          }
        : {
            modelId: null,
            modelIdSource: 'none' as const,
            sourcePromptVersion: currentConstant,
            promptVersionSource: 'current_constant' as const,
          };

      // Build the expected output (extract runs the schema gate first).
      let expected: ExpectedOutput;
      let sourceSchemaVersion: number | null = null;
      if (spec.task_type === 'classify') {
        expected = buildClassifyLabel(spec);
      } else {
        const built = buildExtractLabel(spec.enums);
        if (!built.ok) {
          await insertRejection(pool, {
            operatorActionId: row.operator_action_id,
            taskType: 'extract',
            reviewQueueId: row.review_queue_id,
            callId: row.call_id,
            heldReason: row.held_reason,
            rejectionReason: 'schema',
            rejectionCounts: null,
            evalSetVersion: EVAL_SET_VERSION,
            piiGateVersion: PII_GATE_VERSION,
          });
          summary.rejected_schema += 1;
          continue;
        }
        expected = built.expected;
        sourceSchemaVersion = EXTRACT_SCHEMA_VERSION;
      }

      // Residual-PII gate over the redacted input (counts-only).
      const gate = validateRedactedInputSafe(clean.redacted_text, denyTerms);
      if (!gate.safe) {
        await insertRejection(pool, {
          operatorActionId: row.operator_action_id,
          taskType: spec.task_type,
          reviewQueueId: row.review_queue_id,
          callId: row.call_id,
          heldReason: row.held_reason,
          rejectionReason: 'pii',
          rejectionCounts: gate.counts,
          evalSetVersion: EVAL_SET_VERSION,
          piiGateVersion: PII_GATE_VERSION,
        });
        summary.rejected_pii += 1;
        // Sanitized: call_id + category keys only, never values.
        logger.warn(
          {
            component: 'evaluation-cron',
            call_id: row.call_id,
            categories: Object.keys(gate.counts),
          },
          'label candidate held by residual-PII gate — rejected content-free',
        );
        continue;
      }

      await insertLabeledExample(pool, {
        operatorActionId: row.operator_action_id,
        taskType: spec.task_type,
        reviewQueueId: row.review_queue_id,
        callId: row.call_id,
        heldReason: row.held_reason,
        reviewerActor: row.actor,
        redactedInput: clean.redacted_text,
        expectedOutput: expected,
        sourceSchemaVersion,
        evalSetVersion: EVAL_SET_VERSION,
        piiGateVersion: PII_GATE_VERSION,
        ...provenance,
      });
      summary.accepted += 1;
    } catch (err) {
      // Operational failure (a repository insert / gate crash). Count it — the caller withholds the
      // heartbeat — and log the error CLASS only (never a message, which could carry a DB/PII string).
      summary.failed += 1;
      logger.error(
        {
          component: 'evaluation-cron',
          call_id: row.call_id,
          error: err instanceof Error ? err.name : typeof err,
        },
        'label sync failed for a candidate',
      );
    }
  }

  if (summary.missing_clean > 0) {
    const sample = [...missingCleanCalls].sort().slice(0, MISSING_CLEAN_LOG_SAMPLE);
    logger.warn(
      { component: 'evaluation-cron', count: summary.missing_clean, call_ids: sample },
      'label candidates lost to a purged/absent clean transcript (recorded as missing_clean)',
    );
  }
  logger.info(
    {
      component: 'evaluation-cron',
      accepted: summary.accepted,
      rejected_pii: summary.rejected_pii,
      rejected_schema: summary.rejected_schema,
      missing_clean: summary.missing_clean,
      already_present: summary.already_present,
      failed: summary.failed,
    },
    'label sync complete',
  );
  return summary;
}
