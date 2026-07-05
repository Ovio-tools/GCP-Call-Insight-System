import type { JsonValue } from '../db/types.js';
import { extractionRecordSchema, type ExtractionRecord } from '../pipeline/extract/parse.js';
import { HUMAN_REVIEW_PROBLEM_STATEMENT } from '../review/correction-constants.js';
import type {
  ExpectedClassifyOutput,
  ExpectedExtractOutput,
} from '../db/schemas/labeled-examples.js';

/**
 * Pure label builders (Task 6.3): turn a resolved review action into a label spec, build the
 * classify bucket / full extract record, and gate the extract record against the schema. NO DB, NO
 * network, NO PII — the only text path is the redacted transcript, handled separately by the sync.
 *
 * Ground-truth mapping (from the review contract, plan §"Key contract facts"):
 *  - `approve` where `held_reason='classifier_uncertain'` → classify bucket `customer` (an approve
 *    on `emergency_review` is NOT a classify label);
 *  - `mark_non_customer` → `non-customer`; `mark_spam` → `spam`;
 *  - `correct_extraction` (only on `schema_invalid`) → extract label carrying the four controlled
 *    enums from `after.action_params`. The other 9 extract fields are forced safe constants.
 */

/** The classify buckets a reviewer decision can assert as ground truth (never `held`). */
export type LabelBucket = 'customer' | 'non-customer' | 'spam';

/** The raw four enum values pulled from `after.action_params` — validated by {@link buildExtractLabel}. */
export interface RawExtractEnums {
  call_intent: unknown;
  service_category: unknown;
  urgency: unknown;
  sentiment: unknown;
}

export type LabelSpec =
  { task_type: 'classify'; bucket: LabelBucket } | { task_type: 'extract'; enums: RawExtractEnums };

/** The `action_params` object off an `operator_actions.after` jsonb, if present. */
function actionParamsOf(after: JsonValue | null | undefined): Record<string, JsonValue> {
  if (after && typeof after === 'object' && !Array.isArray(after)) {
    const params = (after as Record<string, JsonValue>).action_params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      return params;
    }
  }
  return {};
}

/**
 * Map one resolved review action to its label spec, or `null` when the action is not a label (a
 * reject/reprocess/mark_unresolvable, or an `approve` on a reason other than `classifier_uncertain`).
 */
export function actionToLabelSpec(
  action: string,
  heldReason: string,
  after: JsonValue | null | undefined,
): LabelSpec | null {
  switch (action) {
    case 'approve':
      return heldReason === 'classifier_uncertain'
        ? { task_type: 'classify', bucket: 'customer' }
        : null;
    case 'mark_non_customer':
      return { task_type: 'classify', bucket: 'non-customer' };
    case 'mark_spam':
      return { task_type: 'classify', bucket: 'spam' };
    case 'correct_extraction': {
      const params = actionParamsOf(after);
      return {
        task_type: 'extract',
        enums: {
          call_intent: params.call_intent,
          service_category: params.service_category,
          urgency: params.urgency,
          sentiment: params.sentiment,
        },
      };
    }
    default:
      return null;
  }
}

/** The classify label's expected output — the bucket only. */
export function buildClassifyLabel(spec: { bucket: LabelBucket }): ExpectedClassifyOutput {
  return { bucket: spec.bucket };
}

/**
 * Assemble the full 13-field extraction record from the four reviewer enums plus the same forced
 * safe constants the `correct_extraction` handler writes (`writeCorrectionCandidate`): a
 * human-review problem statement, empty arrays, null nullable fields. This is what the golden
 * fixture's `modelResponse.text` carries; the label's `expected` pins only the four enums.
 *
 * The enums are typed loosely (`unknown`) because they come from an audit-row jsonb; the schema gate
 * in {@link buildExtractLabel} is what validates them.
 */
export function buildExtractRecord(enums: RawExtractEnums): Record<string, unknown> {
  return {
    call_intent: enums.call_intent,
    service_category: enums.service_category,
    problem_statement: HUMAN_REVIEW_PROBLEM_STATEMENT,
    symptoms: [],
    customer_language: [],
    competitor_mentions: [],
    concerns: [],
    location_in_home: null,
    access_or_scheduling_notes: null,
    prior_attempts: null,
    acquisition_source: null,
    urgency: enums.urgency,
    sentiment: enums.sentiment,
  };
}

/**
 * The extract schema gate. Builds the full record and validates it against `extractionRecordSchema`
 * (the same gate the pipeline uses). On success returns the validated record AND the four-enum
 * `expected` output for storage; on failure surfaces the schema failure so the sync records a
 * content-free `schema` rejection rather than a bad label.
 */
export function buildExtractLabel(
  enums: RawExtractEnums,
): { ok: true; record: ExtractionRecord; expected: ExpectedExtractOutput } | { ok: false } {
  const parsed = extractionRecordSchema.safeParse(buildExtractRecord(enums));
  if (!parsed.success) return { ok: false };
  const record = parsed.data;
  return {
    ok: true,
    record,
    expected: {
      call_intent: record.call_intent,
      service_category: record.service_category,
      urgency: record.urgency,
      sentiment: record.sentiment,
    },
  };
}
