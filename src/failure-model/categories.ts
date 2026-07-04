import { z } from 'zod';
import { isPipelineStage } from '../pipeline/stages.js';

/**
 * The operational failure model (CLAUDE.md §4 / build plan §2.7): the complete
 * root-cause taxonomy and the supporting enums the model is built from.
 *
 * This module is the canonical home the "forerunner" error modules fold into:
 * `src/config/index.ts` (`CONFIG_MISSING_OR_INVALID`), `src/boot/codes.ts`
 * (`DATABASE_UNAVAILABLE` / `REDIS_UNAVAILABLE` / `MIGRATION_FAILED`), and the
 * `SEAM(Task 2.2)` worker shims. Those are left untouched for now; their codes are
 * §4 taxonomy members and get catalog entries here.
 */

/**
 * Every failure maps to exactly one of these root-cause categories (CLAUDE.md §4).
 * The DAL-internal codes in `src/db/errors.ts` are deliberately NOT members — they
 * are not part of the §4 taxonomy.
 */
export const ROOT_CAUSE_CATEGORIES = [
  'CONFIG_MISSING_OR_INVALID',
  'DATABASE_UNAVAILABLE',
  'REDIS_UNAVAILABLE',
  'MIGRATION_FAILED',
  'DIALPAD_AUTH_FAILED',
  'DIALPAD_RATE_LIMITED',
  'DIALPAD_API_CHANGED',
  'DIALPAD_TRANSCRIPT_MISSING',
  'WEBHOOK_SIGNATURE_INVALID',
  'WEBHOOK_REPLAY_DETECTED',
  'REDACTION_RECALL_REGRESSION',
  'REDACTION_LOW_CONFIDENCE',
  'MODEL_AUTH_FAILED',
  'MODEL_RATE_LIMITED',
  'MODEL_MALFORMED_RESPONSE',
  'MODEL_COST_CAP_EXCEEDED',
  // Warning threshold (Task 7.2): an advisory, PII-free, non-blocking alert emitted at most
  // once per UTC day when estimated daily model spend crosses
  // DAILY_MODEL_COST_CAP_USD * DAILY_MODEL_COST_WARNING_THRESHOLD_RATIO. Distinct from the
  // hard-cap MODEL_COST_CAP_EXCEEDED, which pauses new sends and holds the call.
  'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
  'QUEUE_RETRY_EXHAUSTED',
  'DEAD_LETTER_CREATED',
  'RETENTION_PURGE_FAILED',
  'BACKFILL_CHECKPOINT_FAILED',
  'REVIEW_QUEUE_STALLED',
  'SERVICETITAN_AUTH_FAILED',
  'SERVICETITAN_MATCH_WEAK',
  'SERVICETITAN_WRITE_FAILED',
  // HTTP hardening & auth middleware (Task 2.3). The shared middleware rejects requests with
  // these codes instead of ad hoc strings; routine client rejections are logged, not alerted.
  'REQUEST_BODY_TOO_LARGE',
  'REQUEST_MALFORMED',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMIT_EXCEEDED',
  'AUTH_REQUIRED',
  'CSRF_TOKEN_INVALID',
  'WEBHOOK_TIMESTAMP_INVALID',
  'INTERNAL_ERROR',
  // Authenticated but insufficient role (Task 6.2). Distinct from AUTH_REQUIRED (unauthenticated):
  // a valid session lacking the REVIEW_ELEVATED_ROLE needed for an elevated raw/vault reveal is
  // refused 403. A routine client rejection — logged, not alerted.
  'AUTH_FORBIDDEN',
  // Extract stage (Task 5.2). The second PII scan found possible residual PII in a
  // model-extracted verbatim marketing phrase — a POST-extraction hit, distinct from the
  // pre-egress redaction holds: the redacted transcript already crossed to Anthropic.
  'VERBATIM_PII_DETECTED',
] as const;

export const rootCauseCategorySchema = z.enum(ROOT_CAUSE_CATEGORIES);
export type RootCauseCategory = z.infer<typeof rootCauseCategorySchema>;

/**
 * Stable error codes. For now these are 1:1 with the root-cause categories (matching
 * how the forerunners already use category names as codes). Modeled as a distinct
 * enum so a finer-grained code can diverge from its category later.
 */
export const ERROR_CODES = ROOT_CAUSE_CATEGORIES;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Whether the pipeline is paused, degraded, or continuing (situational, per failure). */
export const PROCESSING_STATE = ['paused', 'degraded', 'continuing'] as const;
export const processingStateSchema = z.enum(PROCESSING_STATE);
export type ProcessingState = z.infer<typeof processingStateSchema>;

/**
 * What is happening to affected calls. `none` = infra/boot failures with no in-flight
 * calls (e.g. a config error at boot, a cost cap that only blocks new sends).
 */
export const CALLS_STATE = ['held', 'retried', 'dropped', 'none'] as const;
export const callsStateSchema = z.enum(CALLS_STATE);
export type CallsState = z.infer<typeof callsStateSchema>;

/**
 * The system components (CLAUDE.md §1.1), as the fixed enum for the `component` context
 * key so heartbeat/status alerts can be component-scoped. Kebab-case, aligned to the
 * service entrypoints under `src/services/*` and their logger `name`s.
 */
export const COMPONENT = [
  'webhook-receiver',
  'worker',
  'reconciliation-cron',
  'retention-cron',
  'backfill',
  'review-surface',
  'status-surface',
  'knowledge-base-surface',
] as const;
export const componentSchema = z.enum(COMPONENT);
export type Component = z.infer<typeof componentSchema>;

/**
 * Allowlisted context keys and how each value is validated. Pipeline stages are NOT
 * redefined here — `isPipelineStage` from the pipeline layer is the single source of
 * truth. Identifier keys (`call_id`, `job_id`) are validated by `sanitizeContext` in
 * `error.ts` (trim + length), not by an enum.
 */
export function isValidComponent(value: string): value is Component {
  return (COMPONENT as readonly string[]).includes(value);
}

export { isPipelineStage };
