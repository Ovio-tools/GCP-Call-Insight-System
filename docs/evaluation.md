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

---

# Technician-note evaluation (`note_feedback`)

The same machinery, pointed at the technician notes (ADR 0009). Reviewers judge individual note
FIELDS in the note-review surface; those verdicts land in the append-only `note_feedback` table and
become (a) a labeled corpus of field-level assertions and (b) the note-quality report.

## Why a note label is not a full expected record

A `correct_extraction` review action carries a whole corrected record, so an extract label can pin
all four controlled enums at once. A note verdict is **per field**: a reviewer marks
`equipment.type` wrong and says nothing at all about the other thirty-five fields. So a note label
is a set of **field-level assertions**:

```json
{
  "assertions": [
    {
      "field_path": "equipment.type",
      "verdict": "correct",
      "corrected_enum_value": null,
      "contested": false
    },
    {
      "field_path": "occupancy",
      "verdict": "wrong",
      "corrected_enum_value": "tenant",
      "contested": false
    }
  ]
}
```

**A field with no verdict is absent, not assumed correct.** Treating silence as agreement would
invent ground truth nobody gave and inflate every accuracy number the reviewers exist to measure.
`corrected_enum_value` is present only where the controlled vocabulary allows one — free-text
fields admit no correction at all, which is what keeps reviewer prose out of the system.
`contested` marks a field two reviewers disagree about; the latest standing verdict wins, but the
disagreement is surfaced rather than averaged away.

**Standing verdicts.** `note_feedback` is append-only: a revision is a new row. Everything here
counts the STANDING verdict — the latest row per `(call_id, note_prompt_version, field_path,
reviewer_actor)`, the same resolution `getLatestNoteFeedback` applies in SQL. A revised verdict
counts once, at its latest value.

## No table, no migration

`labeled_examples` exists because its input (`clean_transcripts`) is purgeable, so a label must be
captured before its source disappears. Both note inputs — `technician_notes` and `note_feedback` —
are **never purged** (ADR 0009), so a note label stays derivable from stored rows forever.
Persisting a copy would only add a second source of truth to keep in sync. This is also what makes
the fixtures reproducible: **no live model call is ever made**, and re-running the export over
unchanged rows rewrites byte-identical files.

## Commands

- `npm run notes:report` — the note-quality report (read-only; writes nothing, calls no model).
  Flags: `--json` (the report object instead of the rendered text), `--out <file>`.
- `npm run notes:export -- --out <dir>` — project the verdicts into golden-fixture files
  (`note-feedback-*.json`, clean-before-write, deterministic filenames, a `MANIFEST.json`).
  Defaults to the gitignored `var/evaluation/note-fixtures`.

## What the report says

1. **What the phone intake keeps failing to establish** — the most frequent `not_established`
   entries across all stored notes. This is the highest-value output of the whole feature and the
   one that is not about the model at all: `not_established` is computed in code from
   `REQUIRED_FOR_DISPATCH`, so a field high on this list means the CALL SCRIPT keeps failing to ask
   that question. Fixing the script is worth more to the business than the notes are.
2. **Agreement per field path, worst first** — which fields the model actually gets wrong. "The
   notes are 82% right" is unactionable; "we get `occupancy` wrong two times in three" is a fix.
3. **Agreement by note prompt version** — so a prompt change can be _shown_ to have helped. Verdicts
   stay attached to the version they were given against, which is why regenerating a note never
   invalidates the previous version's numbers.

## Version drift, and what it costs

A note is regenerated **in place** (PK `call_id`), so once a call is re-noted the note the verdicts
were given against is gone. Consequences, deliberately different per output:

- the **report** still counts those verdicts, grouped by the version they were given against — that
  comparison is the whole point;
- the **fixture export** skips them (`version_drift`), because a fixture needs the note text and
  that text no longer exists.

## Privacy posture

Both inputs are de-identified stores; raw transcripts and the vault live in DB-B and are
unreachable from here. On top of that:

- the fixture export re-runs the generator's own `scanNoteForResidual` over the note's free-text
  fields (a hit rejects the fixture **content-free**, categories only) and the residual gate over
  the redacted transcript (a hit **withholds** the text; the assertions are still exported, since a
  purged or withheld transcript does not invalidate them);
- the **report** carries no free text at all — field paths, verdict names, prompt versions, and
  counts. `not_established` entries are re-checked against `NOTE_FIELD_PATHS` and anything
  unrecognized is counted, never printed. Call ids and reviewer identities never appear.
- the rendered report obeys two formatting invariants so it cannot trip the very scanner the
  pipeline relies on: every number is preceded by a label word (adjacent numeric columns would
  concatenate into a false `digit_run`), and no single number ever reaches seven digits (counts past
  a million are scaled, `9.88M`). `test/evaluation/note-report.test.ts` runs `residualScan` over the
  fully rendered output.
