# Sample-validation harness (Task 11.1)

The sample-validation harness runs a **small, bounded batch of real calls** through the full
pipeline **in staging**, then produces a **PII-free side-by-side review report** of the redacted
text and the extracted record so we can judge quality and tune the classifier/extractor before
going wide. It is the **one consented exception** to the synthetic-only rule (plan §0.2): outside
this task, every phase up to and including Phase 11 uses synthetic fixtures.

Code: `src/sample-validation/` (guards, gates, selection, report, marking, orchestrator).
CLIs: `src/scripts/run-sample-validation.ts`, `src/scripts/mark-sample.ts`.

## What it refuses (all before any side effect)

`runSampleValidation` enforces, in order, and **stops before any Dialpad fetch, model call, queue
enqueue, pipeline run, or report write** if any check fails:

1. **Staging only.** `NODE_ENV` must be `staging`. Production or any other environment is refused
   even when credentials are present (`reason: 'not_staging'`).
2. **No production resource.** The configured database, queue (Redis), and service endpoints
   (Dialpad, OIDC, plus any caller-supplied) are host-screened against a conservative production
   marker list (`prod`, `production`). A match refuses the run (`reason: 'production_resource'`).
   Only the URL **host** is screened, so a secret containing `prod` cannot trip it, and a
   production host cannot be reached even from inside a staging process.
3. **Bounded selection.** The operator supplies **either** an explicit call-id list **or** a sample
   size, never both, capped by a conservative maximum (`DEFAULT_MAX_SAMPLE_SIZE = 25`).
4. **§0.2 processing gates recorded.** Every §0.2 processing gate must exist in `consent_gates`:
   - `dialpad_recording_consent` — Dialpad recording / share consent,
   - `signed_services_agreement`,
   - `signed_data_processing_addendum`,
   - `anthropic_no_training_confirmation`,
   - `anthropic_data_retention_confirmation`.

   The **ServiceTitan matching consent** (`servicetitan_matching_consent`) is required **only** when
   the run exercises ServiceTitan / `match_keys` / matching behavior (`--servicetitan`), and is
   **not** required otherwise. A missing gate refuses the run (`reason: 'missing_consent_gates'`,
   with the missing gate types in `context.missing`).

It **writes nothing to any production store** and enqueues no production jobs: the guards refuse a
production database/queue/endpoint, and the harness itself only reads (for the report) and delegates
processing to the injected pipeline runner.

## The report

`buildSampleReport` assembles each entry **entirely from de-identified stores** — `call_state`,
`clean_transcripts`, `structured_knowledge`, the classify `processing_log`, and `review_queue`. It
**never reads `raw_transcripts` or `token_vault`**, so raw transcript text and vault values cannot
enter the report by construction. Each entry carries: call id, pipeline status + stage, drop reason,
classifier bucket, hold reason, redacted text, the extracted record, prompt/model/schema versions,
and validation metadata.

Excluded / defended:

- **`sentiment`** is internal-only (ADR) and never appears.
- Every free-text field is re-screened by the residual-PII gate (counts-only, over the deny list) as
  defense-in-depth. A hit **withholds** that text and records a sanitized `pii_guard_tripped` flag +
  category keys — never the values.

## Marking → the Phase 6.3 labeled baseline

`markSample` records a reviewer's ground-truth assertion for a sample as a `review_queue` +
append-only `operator_actions` audit row shaped exactly as the review surface would — so the
**existing** `syncLabeledExamples` derivation (`seedLabeledBaseline`) mines it into
`labeled_examples` with **no duplicated label logic**. The reviewer asserts:

- **classify**: the ground-truth bucket (`customer` → `approve` on a `classifier_uncertain` hold;
  `non-customer` → `mark_non_customer`; `spam` → `mark_spam`);
- **extract**: the four controlled enums (`call_intent`, `service_category`, `urgency`,
  `sentiment`) → `correct_extraction` on a `schema_invalid` hold.

The correct/wrong verdict and optional reviewer notes live on the audit row only; the label is the
asserted ground truth, and `syncLabeledExamples` reads **only** the controlled fields (never notes),
with its residual-PII + schema gates applied before an example is accepted.

## Running it (staging operator)

```bash
# Process an explicit set of already-ingested staging calls, write the PII-free report to a file:
node dist/scripts/run-sample-validation.js --calls call_a,call_b,call_c --out report.json

# Or a capped sample of the most recent calls:
node dist/scripts/run-sample-validation.js --size 10

# Add --servicetitan only if the run exercises ServiceTitan / match-key behavior.

# Mark a reviewed sample and seed the labeled baseline:
node dist/scripts/mark-sample.js --call call_a --task classify --verdict correct --bucket customer --seed
node dist/scripts/mark-sample.js --call call_b --task extract --verdict wrong \
  --intent new_booking --category water_heater --urgency routine --sentiment neutral --seed
```

## Manual staging QA (not covered by CI)

Tests use synthetic fixtures/mocks only and never touch live Dialpad/Anthropic/ServiceTitan. Before
a real run in staging, confirm manually:

- The staging `consent_gates` table holds all five §0.2 processing gates (and the ServiceTitan
  matching consent if the run uses that path).
- `DATABASE_URL` / `REDIS_URL` / `DIALPAD_BASE_URL` / `OIDC_ISSUER_URL` point at staging hosts.
- The key store is seeded for staging (`buildServiceKeyProvider` readiness) so redaction can
  envelope-encrypt.
- Inspect the emitted report is PII-free before sharing it for human review.
