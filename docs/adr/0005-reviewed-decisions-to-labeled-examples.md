# ADR 0005 — Reviewed decisions become labeled examples & evaluation data

Status: accepted (Task 6.3, 2026-07-05)

## Context

When an OVIO reviewer resolves a held call in the Task 6.2 review surface they produce a
_ground-truth signal_: "this call is actually spam / non-customer / customer," or "the
correct extraction enums are X." Today that signal is written only as an audit row
(`operator_actions`) and consumed once (to reprocess the call). Task 6.3 turns those
resolved decisions into a durable, versioned, PII-free labeled corpus that (a) feeds the
existing golden-fixture parse suites and (b) drives a periodic accuracy check on the
classifier and extractor.

Hard boundary (spec §6.3 + build-plan conventions): a labeled example is derived **only**
from already-redacted input (`clean_transcripts`) and the corrected controlled-enum output
(`operator_actions.after.action_params`). Never raw transcript text, vault values, PII, or
clear redaction findings. This task writes **only** evaluation data — never to raw stores,
the vault, production customer output, or any export/marketing surface.

## Decisions

### 1. Mine `operator_actions` asynchronously — never inline in the review handler

A generator (`src/evaluation/sync.ts`) reads the append-only audit rows and derives labels.
`src/review/actions.ts` (the sensitive 6.2 handler) and its tests are untouched **by
construction**. Idempotency is a DB unique constraint, not handler logic. The alternative —
writing a label inline when the reviewer acts — would couple the privacy-critical handler to
the corpus and risk a partial write; mining is decoupled, replayable, and safe to re-run.

### 2. Durable store = a DB table, source of truth, with a fixture export projection

`labeled_examples` (accepted labels + provenance) is the source of truth. The golden-fixture
harness loads a **projection** (`src/evaluation/export-fixtures.ts`) into the existing fixture
format. The eval runner reads the DB, not files, so corpus growth is tracked in Postgres.

### 3. `labeled_examples` is a NEW durable de-identified asset, distinct from `clean_transcripts`

`clean_transcripts` is purgeable; `labeled_examples` is **not** purged — it is the durable
de-identified training/evaluation asset the whole task exists to build. This is permitted
because the row holds only redacted text that has crossed the redaction boundary **and** is
re-scanned by an independent residual-PII gate at capture time (twice-scanned), plus
controlled-enum output with no free text. **Fallback:** if that assertion ever cannot hold
(e.g. a policy change requires these rows to expire), add the standard retention bookkeeping
columns (`retention_eligible_at`/`soft_deleted_at`/`hard_deleted_at`) and a purge group — the
table is otherwise shaped like the other purgeable tables, so the change is additive.

### 4. Accepted labels and rejected attempts are separated, and both are version-scoped

`labeled_example_rejections` records content-free validation failures (`pii` / `schema` /
`missing_clean`). Separating them means a false-positive PII gate never permanently blocks a
correction. BOTH tables key on `UNIQUE(operator_action_id, task_type, pii_gate_version,
eval_set_version)`, so bumping `PII_GATE_VERSION`/`EVAL_SET_VERSION` re-opens previously
accepted AND previously rejected candidates for revalidation under the new version, without
mutating old-version history. `missing_clean` is a terminal, content-free rejection for a
purged/absent clean transcript — it makes the loss visible and idempotent, distinct from an
operational failure.

### 5. An extract label carries ground truth for only FOUR fields

`correct_extraction` accepts only the four controlled enums (`call_intent`,
`service_category`, `urgency`, `sentiment`); the other nine extraction fields are forced safe
constants. The evaluation metric is therefore named **`extract_controlled_field_accuracy`**
with explicit `fields_evaluated` / `fields_not_evaluated` / `label_source='correct_extraction'`
— **never** "full extraction accuracy," which would overstate what the corpus measures.

### 6. Live-only in staging/production; stub reports are never authoritative

The periodic accuracy check writes an `evaluation_reports` row tagged `mode` (`live` |
`test_stub`); only `live` is authoritative. In staging/production, `EVALUATION_RUN_ENABLED=true`

- `EVALUATION_LIVE_MODE=false` is a fail-fast `CONFIG_MISSING_OR_INVALID` — the check must never
  write a non-live report or ping its dead-man's switch green without calling the models. Live
  predictions record `model_invocations` and honor the daily cost cap + kill switches. `dry_run`
  is a CLI-only preview that persists nothing (never a persisted `mode`).

### 7. Generated exports are gitignored; committed reviewed fixtures are synthetic

Real reviewed exports default to a gitignored dir (`var/evaluation/`). Only small hand-authored
**synthetic** reviewed-format fixtures are committed (`test/fixtures/{classify,extract}/reviewed/`),
proving the harness loads the format in CI without ever committing a real redacted transcript.

## Consequences

- Label capture is a health-gated reconciliation-cron duty (every 15 min), so a correction is
  mined well inside the shortest CLEAN soft-purge window; a broken sync withholds the
  reconciliation heartbeat. **Invariant: the label-sync cadence must be shorter than the CLEAN
  soft-purge window.**
- The corpus is PII-free across logs, DB rows, and files, enforced by a residual-scan gate plus
  a negative privacy test that asserts absence in all three.
- A new `evaluation-cron` heartbeat component owns its own external check; there is no
  status-surface mirror for it in this task.
