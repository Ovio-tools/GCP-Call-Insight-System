import type { Pool } from 'pg';
import { countAllCalls } from '../db/repositories/call-state-repo.js';
import {
  countClassifyByBucket,
  countByStageOutcome,
} from '../db/repositories/processing-log-repo.js';
import { countOpenByReason } from '../db/repositories/review-queue-repo.js';
import { countDeadLettersByCode } from '../db/repositories/dead-letter-repo.js';
import { countAlertsByCodeSeverity } from '../db/repositories/alert-events-repo.js';

/**
 * Operational counters (Task 7.4), usable by the Task 7.3 status surface. These are DERIVED
 * from the already-written audit tables (processing_log, review_queue, dead_letter,
 * alert_events, call_state) rather than a parallel in-process counter registry — so they are
 * cross-process-correct, idempotent under BullMQ retries, and the audit trail stays the single
 * source of truth. Every label is drawn from a small CLOSED, low-cardinality set; per-call and
 * per-job identifiers, and any transcript-derived value, are NEVER used as a label.
 */

/** The ONLY label keys any counter may carry. Enforced by {@link assertLowCardinality}. */
export const COUNTER_LABEL_KEYS = [
  'stage',
  'outcome',
  'bucket',
  'held_reason',
  'error_code',
  'severity',
  'environment',
] as const;

export type CounterLabelKey = (typeof COUNTER_LABEL_KEYS)[number];

/** The classifier's closed bucket vocabulary; any other value is collapsed to `unknown`. */
const CLASSIFY_BUCKETS = new Set(['customer', 'non-customer', 'spam', 'held']);

export interface Counter {
  /** Stable counter name, e.g. `calls_ingested_total`. */
  name: string;
  /** Low-cardinality labels only (see {@link COUNTER_LABEL_KEYS}). */
  labels: Partial<Record<CounterLabelKey, string>> & Record<string, string>;
  /** The current count. */
  value: number;
}

export interface CollectCountersDeps {
  /** The deployment environment, used as a low-cardinality label on every counter. */
  environment: string;
}

/** Throw if any counter carries a label outside the allowlist (defense-in-depth vs. cardinality). */
function assertLowCardinality(counters: Counter[]): void {
  const allowed = new Set<string>(COUNTER_LABEL_KEYS);
  for (const c of counters) {
    for (const key of Object.keys(c.labels)) {
      if (!allowed.has(key)) {
        throw new Error(
          `metrics: counter '${c.name}' has disallowed high-cardinality label '${key}'`,
        );
      }
    }
  }
}

/**
 * Collect the current operational counters from the audit tables. One row per distinct label
 * combination; a bucket/reason/code with no rows simply does not appear (a 0 is the absence of
 * a labelled counter, matching the status surface's null/0 discipline at the aggregate layer).
 */
export async function collectCounters(pool: Pool, deps: CollectCountersDeps): Promise<Counter[]> {
  const env = deps.environment;
  const [ingested, classified, extracted, heldByReason, deadLettered, alerts] = await Promise.all([
    countAllCalls(pool),
    countClassifyByBucket(pool),
    countByStageOutcome(pool, 'extract', 'completed'),
    countOpenByReason(pool),
    countDeadLettersByCode(pool),
    countAlertsByCodeSeverity(pool),
  ]);

  const counters: Counter[] = [];
  counters.push({ name: 'calls_ingested_total', labels: { environment: env }, value: ingested });
  // Constrain the bucket label to the classifier's closed vocabulary; collapse anything else
  // (should never occur — the parser enforces the enum) to `unknown` so cardinality is bounded.
  const classifiedByBucket = new Map<string, number>();
  for (const c of classified) {
    const bucket = CLASSIFY_BUCKETS.has(c.bucket) ? c.bucket : 'unknown';
    classifiedByBucket.set(bucket, (classifiedByBucket.get(bucket) ?? 0) + c.count);
  }
  for (const [bucket, value] of classifiedByBucket) {
    counters.push({
      name: 'calls_classified_total',
      labels: { environment: env, bucket },
      value,
    });
  }
  counters.push({ name: 'calls_extracted_total', labels: { environment: env }, value: extracted });
  for (const h of heldByReason) {
    counters.push({
      name: 'calls_held_total',
      labels: { environment: env, held_reason: h.held_reason },
      value: h.count,
    });
  }
  for (const d of deadLettered) {
    counters.push({
      name: 'calls_dead_lettered_total',
      labels: { environment: env, error_code: d.error_code },
      value: d.count,
    });
  }
  for (const a of alerts) {
    counters.push({
      name: 'alerts_total',
      labels: { environment: env, error_code: a.error_code, severity: a.severity },
      value: a.count,
    });
  }

  assertLowCardinality(counters);
  return counters;
}
