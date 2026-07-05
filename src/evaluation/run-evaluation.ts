import type { Logger } from 'pino';
import type { LabeledExampleRow } from '../db/schemas/labeled-examples.js';
import type {
  EvaluationSkipReason,
  EvaluationStatus,
  FailureCategory,
} from '../db/schemas/evaluation-reports.js';
import { EVAL_SET_VERSION, EVALUATION_FAILURE_SAMPLE_LIMIT } from './version.js';

/**
 * The pure evaluation runner (Task 6.3): score an injected predictor against the labeled corpus and
 * produce a PII-free, grouped report. NO DB and NO network here — the caller injects predictors
 * (real live ones or CI stubs). The report carries ONLY grouped counts + a bounded ids/enums-only
 * failure sample; it never copies the transcript text.
 *
 * Metrics (finding 3):
 *  - classify: `classify_bucket_accuracy` — predicted bucket vs `expected.bucket`.
 *  - extract: `extract_controlled_field_accuracy` over the FOUR reviewer-correctable fields only,
 *    with per-field accuracy + coverage metadata. NEVER labeled "full extraction accuracy" — the
 *    other 9 fields carry no ground truth (they are forced safe constants).
 */

/** The four extract fields a reviewer correction carries ground truth for. */
export const EXTRACT_CONTROLLED_FIELDS = [
  'call_intent',
  'service_category',
  'urgency',
  'sentiment',
] as const;
type ControlledField = (typeof EXTRACT_CONTROLLED_FIELDS)[number];

/** The nine extract fields NOT evaluated (forced safe constants — no ground truth). */
export const EXTRACT_UNEVALUATED_FIELDS = [
  'problem_statement',
  'symptoms',
  'customer_language',
  'competitor_mentions',
  'concerns',
  'location_in_home',
  'access_or_scheduling_notes',
  'prior_attempts',
  'acquisition_source',
] as const;

export interface ClassifyPrediction {
  bucket: string;
}
export interface ExtractPrediction {
  call_intent: string;
  service_category: string;
  urgency: string;
  sentiment: string;
}

/**
 * A single prediction outcome. `ok` carries the value; `malformed`/`error` are per-example failures
 * (still count as evaluated); `cost_capped`/`killed` are run-level stops (the caller ceases and
 * counts the rest as skipped).
 */
export type PredictResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'malformed' }
  | { status: 'error' }
  | { status: 'cost_capped' }
  | { status: 'killed' };

export type ClassifyPredictor = (
  ex: LabeledExampleRow,
) => Promise<PredictResult<ClassifyPrediction>>;
export type ExtractPredictor = (ex: LabeledExampleRow) => Promise<PredictResult<ExtractPrediction>>;

export interface RunEvaluationInput {
  examples: LabeledExampleRow[];
  classifyPredictor: ClassifyPredictor;
  extractPredictor: ExtractPredictor;
  now: Date;
  logger?: Logger;
}

interface GroupTally {
  task_type: string;
  prompt_version: string;
  model_id: string | null;
  eval_set_version: number;
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
}

interface FieldTally {
  total: number;
  correct: number;
  accuracy: number;
}

export interface ClassifyMetric {
  metric: 'classify_bucket_accuracy';
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
}
export interface ExtractMetric {
  metric: 'extract_controlled_field_accuracy';
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  per_field: Record<ControlledField, FieldTally>;
  fields_evaluated: readonly string[];
  fields_not_evaluated: readonly string[];
  label_source: 'correct_extraction';
}

export interface EvaluationFailure {
  labeled_example_id: string;
  task_type: 'classify' | 'extract';
  expected: string | Record<string, string> | null;
  predicted: string | Record<string, string> | null;
  failure_category: FailureCategory;
}

export interface EvaluationReport {
  eval_set_version: number;
  generated_at: Date;
  byTaskType: { classify?: ClassifyMetric; extract?: ExtractMetric };
  byGroup: GroupTally[];
  failures: EvaluationFailure[];
  examples_evaluated: number;
  examples_skipped: number;
  status: EvaluationStatus;
  skip_reason: EvaluationSkipReason;
}

function accuracy(correct: number, total: number): number {
  return total === 0 ? 0 : correct / total;
}

function groupKey(ex: LabeledExampleRow): string {
  return `${ex.task_type}|${ex.source_prompt_version}|${ex.model_id ?? 'none'}|${ex.eval_set_version}`;
}

export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationReport> {
  const { examples, classifyPredictor, extractPredictor, now, logger } = input;

  const classify = { total: 0, correct: 0, incorrect: 0 };
  const perField: Record<ControlledField, FieldTally> = {
    call_intent: { total: 0, correct: 0, accuracy: 0 },
    service_category: { total: 0, correct: 0, accuracy: 0 },
    urgency: { total: 0, correct: 0, accuracy: 0 },
    sentiment: { total: 0, correct: 0, accuracy: 0 },
  };
  const extract = { total: 0, correct: 0, incorrect: 0 };
  const groups = new Map<string, GroupTally>();
  const failures: EvaluationFailure[] = [];
  let evaluated = 0;
  let skipped = 0;
  let stopReason: 'cost_capped' | 'killed' | null = null;

  const bumpGroup = (ex: LabeledExampleRow, correct: boolean): void => {
    const key = groupKey(ex);
    let g = groups.get(key);
    if (!g) {
      g = {
        task_type: ex.task_type,
        prompt_version: ex.source_prompt_version,
        model_id: ex.model_id,
        eval_set_version: ex.eval_set_version,
        total: 0,
        correct: 0,
        incorrect: 0,
        accuracy: 0,
      };
      groups.set(key, g);
    }
    g.total += 1;
    if (correct) g.correct += 1;
    else g.incorrect += 1;
  };

  const pushFailure = (f: EvaluationFailure): void => {
    if (failures.length < EVALUATION_FAILURE_SAMPLE_LIMIT) failures.push(f);
  };

  /** Record a run-level stop (cost cap / kill switch): the triggering + remaining examples are
   * skipped. Returns true so the caller breaks the loop. */
  const recordStop = (ex: LabeledExampleRow, status: 'cost_capped' | 'killed', i: number): void => {
    stopReason = status;
    skipped = examples.length - i;
    pushFailure({
      labeled_example_id: ex.id,
      task_type: ex.task_type,
      expected: expectedValue(ex),
      predicted: null,
      failure_category: status,
    });
  };

  loop: for (let i = 0; i < examples.length; i += 1) {
    const ex = examples[i]!;

    if (ex.task_type === 'classify') {
      const outcome = await classifyPredictor(ex);
      if (outcome.status === 'cost_capped' || outcome.status === 'killed') {
        recordStop(ex, outcome.status, i);
        break loop;
      }
      evaluated += 1;
      classify.total += 1;
      const expected = (ex.expected_output as { bucket: string }).bucket;
      if (outcome.status === 'ok') {
        const correct = outcome.value.bucket === expected;
        if (correct) classify.correct += 1;
        else {
          classify.incorrect += 1;
          pushFailure({
            labeled_example_id: ex.id,
            task_type: 'classify',
            expected,
            predicted: outcome.value.bucket,
            failure_category: 'mismatch',
          });
        }
        bumpGroup(ex, correct);
      } else {
        classify.incorrect += 1;
        pushFailure({
          labeled_example_id: ex.id,
          task_type: 'classify',
          expected,
          predicted: null,
          failure_category: outcome.status === 'malformed' ? 'model_malformed' : 'prediction_error',
        });
        bumpGroup(ex, false);
      }
      continue;
    }

    // extract
    const outcome = await extractPredictor(ex);
    if (outcome.status === 'cost_capped' || outcome.status === 'killed') {
      recordStop(ex, outcome.status, i);
      break loop;
    }
    evaluated += 1;
    extract.total += 1;
    const expectedEnums = ex.expected_output as Record<ControlledField, string>;
    if (outcome.status === 'ok') {
      let allMatch = true;
      for (const field of EXTRACT_CONTROLLED_FIELDS) {
        perField[field].total += 1;
        if (outcome.value[field] === expectedEnums[field]) perField[field].correct += 1;
        else allMatch = false;
      }
      if (allMatch) extract.correct += 1;
      else {
        extract.incorrect += 1;
        pushFailure({
          labeled_example_id: ex.id,
          task_type: 'extract',
          expected: expectedEnums,
          predicted: {
            call_intent: outcome.value.call_intent,
            service_category: outcome.value.service_category,
            urgency: outcome.value.urgency,
            sentiment: outcome.value.sentiment,
          },
          failure_category: 'mismatch',
        });
      }
      bumpGroup(ex, allMatch);
    } else {
      // malformed / error — every controlled field counts toward its total but none as correct.
      for (const field of EXTRACT_CONTROLLED_FIELDS) perField[field].total += 1;
      extract.incorrect += 1;
      pushFailure({
        labeled_example_id: ex.id,
        task_type: 'extract',
        expected: expectedEnums,
        predicted: null,
        failure_category: outcome.status === 'malformed' ? 'model_malformed' : 'prediction_error',
      });
      bumpGroup(ex, false);
    }
  }

  for (const field of EXTRACT_CONTROLLED_FIELDS) {
    perField[field].accuracy = accuracy(perField[field].correct, perField[field].total);
  }
  for (const g of groups.values()) g.accuracy = accuracy(g.correct, g.total);

  const byTaskType: { classify?: ClassifyMetric; extract?: ExtractMetric } = {};
  if (classify.total > 0) {
    byTaskType.classify = {
      metric: 'classify_bucket_accuracy',
      total: classify.total,
      correct: classify.correct,
      incorrect: classify.incorrect,
      accuracy: accuracy(classify.correct, classify.total),
    };
  }
  if (extract.total > 0) {
    byTaskType.extract = {
      metric: 'extract_controlled_field_accuracy',
      total: extract.total,
      correct: extract.correct,
      incorrect: extract.incorrect,
      accuracy: accuracy(extract.correct, extract.total),
      per_field: perField,
      fields_evaluated: EXTRACT_CONTROLLED_FIELDS,
      fields_not_evaluated: EXTRACT_UNEVALUATED_FIELDS,
      label_source: 'correct_extraction',
    };
  }

  const { status, skipReason } = completeness(examples.length, evaluated, stopReason);

  if (skipped > 0 && logger) {
    logger.warn(
      { component: 'evaluation-cron', skip_reason: skipReason, examples_skipped: skipped },
      'evaluation left examples unscored — cost cap / kill switch tripped',
    );
  }

  return {
    eval_set_version: EVAL_SET_VERSION,
    generated_at: now,
    byTaskType,
    byGroup: [...groups.values()],
    failures,
    examples_evaluated: evaluated,
    examples_skipped: skipped,
    status,
    skip_reason: skipReason,
  };
}

/** Enum/bucket ground-truth value of an example — for a failure sample entry. */
function expectedValue(ex: LabeledExampleRow): string | Record<string, string> {
  if (ex.task_type === 'classify') return (ex.expected_output as { bucket: string }).bucket;
  return ex.expected_output;
}

/** Derive the run's completeness status + skip_reason (mirrors the DB / zod cross-field CHECK). */
function completeness(
  total: number,
  evaluated: number,
  stopReason: 'cost_capped' | 'killed' | null,
): { status: EvaluationStatus; skipReason: EvaluationSkipReason } {
  if (total === 0) return { status: 'skipped', skipReason: 'no_examples' };
  if (stopReason === null) return { status: 'complete', skipReason: 'none' };
  if (evaluated === 0) return { status: 'skipped', skipReason: stopReason };
  return { status: 'partial', skipReason: stopReason };
}
