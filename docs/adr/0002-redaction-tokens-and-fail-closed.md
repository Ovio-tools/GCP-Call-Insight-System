# ADR 0002 — Redaction stage: in-process NER, per-call tokens, fail-closed holds

Status: accepted (Task 4.1, 2026-07-01)

## Context

The redact stage is the system privacy boundary (build plan §2.2): only redacted
text may cross to the Anthropic API. The stage needs a named-entity detector, a
token scheme for the vault, a risk model, and rules for what survives a hold.

## Decisions

### 1. NER runs in-process via transformers.js (no Presidio sidecar)

`@huggingface/transformers` (pinned exact, 4.2.0) runs `Xenova/bert-base-NER`
(quantized ONNX, `dtype: 'q8'`, ~113 MB on disk; MIT-licensed per the
dslim/bert-base-NER model card) inside the worker process. Rationale over
Microsoft Presidio: Presidio is Python — a second Railway runtime and transcript
text crossing a service boundary; in-process inference keeps the raw text inside
one process with a hard offline switch (`env.allowRemoteModels = false`). The
model is vendored at build time (`npm run model:fetch`, the only network path
for weights); a missing model fails the stage into retry/dead-letter and never
downloads in the per-call path.

Step-0 spike numbers (15 synthetic snippets): the token-classification pipeline
returns NO char offsets (a cursor-based wordpiece aligner reconstructs them);
single-pass recall 22/24 — both misses all-lowercase names (the model is cased);
dual-pass (original + title-cased copy, identical length so offsets map 1:1)
24/24 with clean no-PII controls. Detection therefore always runs both passes.

### 2. Every NER candidate span is redacted, regardless of confidence

`REDACTION_NER_MIN_SCORE` is a risk signal (`ner_low_confidence`), never a drop
threshold. Over-redaction costs a placeholder token; a dropped suspected name is
a privacy-boundary leak. The only unredacted NER outcome is a failed offset
alignment, and that forces a hold (`ner_offset_alignment_failed`).

### 3. Per-call token scheme; no cross-call linkage

Tokens are `[TYPE_n]`, numbered per entity type per call in order of first
occurrence; equal normalized surfaces share one token within a call. Numbering
restarts every call and the vault key is `(call_id, token)`, so `[NAME_1]` in
two calls is unrelated. `redaction_findings.value_hash` is
`HMAC-SHA256(key, call_id ‖ 0x00 ‖ normalized_value)` — per-call binding makes
identical values hash differently across calls. Cross-call identity remains
exclusively the `match_keys` table's job.

### 4. Risk reasons carry a safety classification; holds are fail-closed

Each reason is `safe_after_redaction` (everything suspected WAS tokenized) or
`unsafe_uncertain_surface` (coverage itself is in doubt). Hold when
`forcedHold || score >= REDACTION_RISK_THRESHOLD` (`>=` plus the explicit flag
so forced reasons hold even at threshold 1). A held call keeps its
`clean_transcripts` row ONLY when every triggered reason is safe; residual hits
and unsafe risk holds soft-delete it instead — `clean_transcripts` is an
unencrypted `app_role` table and must never carry text known or suspected to
contain PII. The upsert clears `soft_deleted_at` on a passing rerun but is
guarded `WHERE hard_deleted_at IS NULL`: redaction never rewrites a
retention-final row (zero-row conflict throws a retention-conflict DalError).

### 5. The residual scan is independent and always audited

The second scan shares only `TOKEN_PATTERN` (our own output format) with the
primary layers: its own aggressive normalizer, its own structural patterns
(digit runs, spelled-out digit words incl. "oh"/"double", Unicode-confusable
at-signs, address keywords near numbers, name shapes after greeting cues), a
vault-originals recheck, and a deny-list recheck. Any hit holds
`residual_pii_detected`. Every run writes a call-level
`entity_type='residual_scan'` findings row (categories/counts only), so a
residual-only hit still leaves an auditable record.

### 6. Downstream contract is mechanically enforced

Model stages read only `getCleanTranscript`. The model-stage import guard test
fails any `src/pipeline/` module (except `fetch-transcript.ts`/`redact.ts`) that
imports the raw-transcript repo, anything under `src/db/restricted/`, or a
barrel that re-exports them.

## Consequences

- Worker image grows ~113 MB (weights) and inference adds ~0.1–0.5 s per
  512-token chunk on CPU; acceptable at current volume, revisit
  `WORKER_CONCURRENCY` if contention appears.
- CI runs the recall/no-egress/adversarial gates against the real model
  (actions/cache'd weights); disabling a detection layer without a residual
  backstop fails CI with `REDACTION_RECALL_REGRESSION` (verified by sabotage:
  NER off ⇒ gate fails; phone regex off alone ⇒ residual digit-run holds
  instead — defense in depth).
- False holds are accepted by design: a false hold costs review time; a false
  pass costs the privacy boundary.
