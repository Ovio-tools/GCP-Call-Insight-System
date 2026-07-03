# ADR 0003 — Extract stage: schema-validation gate, deterministic urgency, no confidence scores

Status: accepted (Task 5.2, 2026-07-02)

## Context

The extract stage (build plan §3, Sonnet) turns a redacted transcript into a
structured record against a fixed schema. It runs after redact and classify, so
its input is already de-identified, but its output is the durable asset
(`structured_knowledge`) and the last model step before store. The stage needs
rules for what a valid record is, who decides urgency, what leaves the boundary,
and what is deliberately NOT persisted. It ships behind `EXTRACT_ENABLED`
(default `false`) like classify, so it also needs a documented recovery path for
calls parked while the switch was off.

## Decisions

### 1. A `.strict()` schema-validation gate rejects malformed output → hold `schema_invalid`

`parseExtraction` (`src/pipeline/extract/parse.ts`) is a pure module that turns a
raw model result into either a validated `ExtractionRecord` or one exact failure
kind. Stop-reason checks run FIRST (`refusal`, `truncated` on `max_tokens`,
`unexpected_stop_reason` for anything not `end_turn`/`stop_sequence`), then an
empty-text check, then a whole-string `JSON.parse` (fenced JSON, prose+JSON, two
objects, and trailing prose all fail as `non_json` — no salvage scanning), then a
zod `.strict()` mirror of the wire schema (`EXTRACT_OUTPUT_FORMAT`). Any extra
key or wrong enum fails as `schema_invalid`. Every malformed outcome holds the
call with reason `schema_invalid` and emits one `MODEL_MALFORMED_RESPONSE` alert
(`processing_state: continuing`); NOTHING is persisted. A cross-check test asserts
the parser schema's key set and enums equal the wire schema so the two cannot
drift. (This is the divergence from classify, which routes malformed output to a
`held` classification rather than a `schema_invalid` hold; the alert shape is
identical.)

### 2. No confidence scores are ever written

The schema carries no `confidence`/probability field, and `.strict()` means a
smuggled `confidence` key fails validation outright (`schema_invalid`) rather than
being silently dropped. Nothing downstream stores a model confidence, score, or
certainty. Rationale: a written confidence invites treating a de-identified record
as more or less trustworthy than the schema/urgency gates already make it; the
gates are the trust boundary, and a "0.9" would be false precision on a single
model sample. Uncertainty is expressed by holding, not by annotating.

### 3. Urgency is set by a deterministic rule, not the model

`emergencyRule` (`src/pipeline/extract/gates.ts`) — not the model — sets the final
`urgency` and the emergency hold. It runs two tiers over a normalized haystack
(redacted text + `problem_statement` + `symptoms` + `concerns`): an EMERGENCY tier
(the model's own `urgency === 'emergency'`, `call_intent === 'emergency'`, or a
fixed emergency keyword such as "gas leak"/"carbon monoxide"/"burst pipe") that
overrides urgency UP to emergency and holds `emergency_review`; and an AMBIGUOUS
tier (keywords like "cannot shut off"/"no water at all") that upgrades one level
from the model's urgency. The ladder is DERIVED by reversing the `URGENCY` enum so
it cannot drift out of the enum. `triggers` are CONSTANT snake_case ids
(`model_urgency`, `call_intent`, `emergency_keyword`, `ambiguous_upgrade`) —
never the matched text — so logs and the `review_queue` detail carry no verbatim
content. An emergency hold is a routing outcome (like `classified_spam`), NOT a
failure: no `errorCode`, no alert — the `review_queue` row and its SLA are the
signal. The clean, validated record is persisted BEFORE the hold routes, so review
resolves it and the pipeline later resumes to scan/store without re-extracting.

### 4. Sentiment is stored for internal use only

The model returns `sentiment` and it is persisted on the extraction candidate, but
it is an internal-only signal: it is never exposed in the knowledge-base, status,
or any other external/customer-facing output. It exists to inform internal
analytics and review, not to be surfaced or acted on automatically.

### 5. Verbatim `customer_language` passes three extract-owned gates before store

Because `customer_language` is the only verbatim, model-echoed field, it clears
three gates (`src/pipeline/extract/gates.ts`) in PII-precedence order before the
record is persisted: a residual-PII scan (a hit holds `residual_pii_detected`); a
verbatim gate that a reconstructed or paraphrased phrase fails as output badness
(`schema_invalid`, persist nothing); and a token gate that drops any phrase still
carrying a redaction token. This is the extract-side half of the §1.2 second PII
scan — a hit holds the record rather than storing leaked or fabricated text.

## Consequences

- The feature flag ships `EXTRACT_ENABLED=false`. While off, the stage makes no
  Anthropic calls and parks each call with the `extract_disabled` marker in
  `processing_log`.
- Parked calls are recovered ONLY by `npm run requeue:extract`
  (`src/scripts/requeue-parked-extract.ts`), run manually AFTER flipping
  `EXTRACT_ENABLED` back on. Reconciliation cannot rescue them: their `call_state`
  already sits mid-pipeline (stage `extract`), so the sweep treats them as
  in-flight and skips them. The script is call-id-keyed (idempotent) and safe to
  re-run; a call that already moved past extract is a no-op.
- Because urgency is deterministic, the emergency safety net does not depend on
  the model rating its own output — a model that under-rates a gas-leak call is
  still caught by the keyword tier, and a keyword false positive costs review time,
  never a missed emergency.
- The `EXTRACT_*` config (model id, kill switch, token/cost reservation, Sonnet
  list price) lives in `src/config/schema.ts` and is mirrored in `.env.example`.
