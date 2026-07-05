# Evaluation & labeled-examples corpus (Task 6.3)

Reviewed decisions from the Task 6.2 review surface become a durable, versioned, **PII-free**
labeled corpus that feeds the golden-fixture parse suites and drives a periodic accuracy check on
the classify/extract model steps. This is **evaluation data only** — it is never written to raw
stores, the vault, production customer output, or any export/marketing surface.

## The privacy boundary

A labeled example is derived from exactly two things:

- **redacted input** — `clean_transcripts.redacted_text` (already past the redaction boundary), and
- **corrected output** — the controlled enums in `operator_actions.after.action_params`.

Never raw transcript text, vault values, names/phones/addresses/emails, or clear redaction
findings. Before any accepted write, `sync` runs two gates over the redacted input: the extract
**schema gate** (`extractionRecordSchema`) and an independent **residual-PII gate** (`residualScan`,
counts-only). A hit becomes a content-free rejection; the digits/values reach no log line, DB row,
or exported file (`test/evaluation/privacy.test.ts`).

## Data model (migration 016)

| Table                        | Contents                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| `labeled_examples`           | accepted labels: redacted input + expected enums/bucket + provenance |
| `labeled_example_rejections` | content-free failed validations (`pii` / `schema` / `missing_clean`) |
| `evaluation_reports`         | PII-free grouped accuracy reports                                    |

Both label tables key on `UNIQUE(operator_action_id, task_type, pii_gate_version,
eval_set_version)`. Grants are append-only: `app_role` has SELECT/INSERT, never UPDATE/DELETE;
the tables are not purged (see ADR 0005). `EVAL_SET_VERSION` / `PII_GATE_VERSION` /
`EVALUATION_FAILURE_SAMPLE_LIMIT` are code constants in `src/evaluation/version.ts`.

## Label derivation

There is no `correct_classification` action; classify labels derive from three resolved actions,
each gated by a live, PII-clean `clean_transcripts` row:

- `approve` **where `held_reason='classifier_uncertain'`** → bucket `customer` (an `approve` on
  `emergency_review` is **not** a classify label);
- `mark_non_customer` → `non-customer`; `mark_spam` → `spam`.

Extract labels come from `correct_extraction` (allowed only on `schema_invalid`). The corrected
output is the four controlled enums (`call_intent`, `service_category`, `urgency`, `sentiment`);
the other nine extraction fields are forced safe constants, so an extract label carries ground
truth for **only** these four fields — hence the metric is `extract_controlled_field_accuracy`,
never "full extraction accuracy."

## Flow

```
review action (6.2, unchanged) ─▶ operator_actions (audit, source of truth)
   eval:sync ──mines──▶ schema gate → residual-PII gate
        accepted ─▶ labeled_examples          rejected ─▶ labeled_example_rejections (content-free)
   eval:export ──▶ <gitignored>/reviewed/*.json   (loadable by the golden-fixture harness)
   eval:run ─────▶ runEvaluation (live predictors: model_invocations + cost cap + kill switch)
                        ─▶ evaluation_reports (PII-free grouped counts) + structured log
```

## Commands

- `npm run eval:sync` — mine resolved decisions into the corpus (idempotent). Normally the
  reconciliation cron runs this every 15 min; this is the manual runner.
- `npm run eval:export -- --out <dir>` — project accepted labels into fixture files (clean-before-
  write; deterministic filenames; a `MANIFEST.json`). Defaults to the gitignored `var/evaluation/`.
- `npm run eval:run` — the periodic accuracy check (also the weekly Railway cron,
  `dist/services/evaluation-run.js`). Flags: `--stub` (local, non-authoritative `test_stub`
  report), `--dry-run` (print, persist nothing).

## Dependable capture — the label-sync cron duty

`clean_transcripts` is purgeable, so label capture must beat its retention window.
`syncLabeledExamples` is wired as a **health-gated** `runLabelSync` duty on the reconciliation cron
(`runReconciliationCron`, every 15 min UTC). Its operational failure (nonzero `SyncSummary.failed`)
or a throw **withholds the reconciliation heartbeat** — broken label capture alerts. Expected
per-candidate outcomes (accepted / pii / schema / `missing_clean` / already-present) do **not** fail
the cron. **Invariant: the label-sync cadence must be shorter than the CLEAN soft-purge window.**

## Cost, kill switch, and completeness

Live predictors record a `model_invocations` row (stage `evaluation-classify` /
`evaluation-extract`) and honor the daily cost cap + the classify/extract kill switches; a tripped
cap/kill refuses (`cost_capped` / `killed`), it never crashes. A run is `complete` only when every
current-version example was evaluated; a mid-run cap trip is `partial`; a before-any-example trip
(or an empty corpus) is `skipped`. The external check is pinged **only** on a complete live run with
≥1 example evaluated — a partial/skipped/stub/disabled run does not ping (the missed check is the
alert).

## Fixture privacy posture

Real reviewed exports are **not committed** — they default to the gitignored `var/evaluation/`.
Only hand-authored **synthetic** reviewed-format fixtures live under
`test/fixtures/{classify,extract}/reviewed/`, and they load through the same parse suites via the
shared `test/support/fixture-loader.ts`. An export-to-temp-dir test proves generated files load
identically without committing them. The DB table is the source of truth for the eval runner.
