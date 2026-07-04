/**
 * Provenance constants for a `correct_extraction` (schema_invalid) review action (Task 6.2).
 *
 * The action accepts ONLY the four controlled-vocabulary enums — never reviewer free text
 * (residual scanning is not a complete PII guarantee). Every text field is forced to a safe
 * constant: `problem_statement` becomes {@link HUMAN_REVIEW_PROBLEM_STATEMENT}, everything else
 * `[]`/null, `customer_language=[]`. The candidate is written with these provenance constants so
 * the resulting `structured_knowledge` row is unmistakably human-authored, not model output.
 *
 * Defined ONCE here; the `correct_extraction` handler and its drift test both read them, so a
 * change to the provenance is a single-site edit the test pins.
 */
export const HUMAN_REVIEW_PROBLEM_STATEMENT = 'Human-reviewed extraction correction';
export const HUMAN_REVIEW_PROMPT_VERSION = 'human-review-correction-v1';
export const HUMAN_REVIEW_MODEL_ID = 'human-review';
