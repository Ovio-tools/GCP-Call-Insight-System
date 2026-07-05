/**
 * Version stamps for the labeled-examples corpus (Task 6.3). Pure code constants (never config):
 * a change to how a label is DERIVED or GATED must be a reviewed code change, and bumping either
 * value re-opens previously accepted AND previously rejected candidates for revalidation under the
 * new version WITHOUT mutating old-version rows (both label tables key on
 * `(operator_action_id, task_type, pii_gate_version, eval_set_version)`).
 *
 * - `EVAL_SET_VERSION` — bump when the label-derivation logic or the fixture-export format changes.
 * - `PII_GATE_VERSION` — bump when the residual-PII gate gets stricter, forcing a fresh re-scan
 *   (an old accepted row never counts for the new gate version).
 */
export const EVAL_SET_VERSION = 1;
export const PII_GATE_VERSION = 1;

/**
 * Hard cap on the number of per-example failures a single `evaluation_reports` row persists in its
 * `failures` sample (finding R3-5). A code constant, not config: a bad model version could mismatch
 * every example, and the row must not grow unbounded. Aggregate failure counts always live in
 * `summary`; this only bounds the id/enum sample.
 */
export const EVALUATION_FAILURE_SAMPLE_LIMIT = 50;
