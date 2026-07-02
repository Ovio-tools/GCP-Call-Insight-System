# Runbook

Operational runbook for the call-insight pipeline. Every failure-model catalog entry
(`src/failure-model/catalog.ts`) carries a stable `runbookRef` of the form
`runbook#<anchor>`; the anchor resolves to a section heading in this file. Sections are
added as their codes are wired into real stages — a missing section means the code
predates this file, not that the pointer is wrong.

No section may contain transcript content or PII; refer to calls by `call_id` only.

## Verbatim PII detected

<!-- anchor: verbatim-pii-detected — runbookRef of VERBATIM_PII_DETECTED (Task 5.2) -->

**Code:** `VERBATIM_PII_DETECTED` · **Severity:** high · **Calls:** held · **Owner:** OVIO on-call

The extract stage's second PII scan found possible residual PII in a model-extracted
verbatim `customer_language` marketing phrase. The phrase was held/scrubbed, was not
stored in `structured_knowledge`, and will not be exported — but this is a
**post-extraction** hit, so do not assume data is safe: the redacted transcript that
produced the phrase already crossed to Anthropic and may have carried the same value,
and the scan-stage path transiently persisted the phrase in the extraction staging
table (`extraction_candidates`) before scrubbing.

### 1. Was it egressed? (do this first)

1. Open the held call in the review surface by the alert's `call_id`.
2. Load the call's redacted transcript (`clean_transcripts`) — the exact text that was
   sent to Anthropic — and check whether it contains the same value the scan flagged in
   the verbatim phrase.
   - **Yes, the value is in the redacted transcript:** residual PII crossed the privacy
     boundary. This is a redaction recall gap — treat it as a privacy-boundary incident:
     record it in the review notes, and add the value's shape to the deny list and the
     redaction corpus (step 3) before releasing anything.
   - **No, the redacted transcript is clean:** the extractor reconstructed or selected
     risky text (e.g. reassembled spelled-out digits, or quoted a tokenized span in a
     leaky way). No egress occurred, but the extractor prompt needs tightening (step 3).
3. Either way, discard or correct the flagged phrase in review; never store the flagged
   text as-is.

### 2. Resolve the held call

- Correct or drop the verbatim phrase, then approve the record so the rest of the
  extraction is stored; or reject the record entirely if it cannot be salvaged.
- Do not override the hold without completing step 1 — the egress check is the point of
  this alert.

### 3. Close the gap (longer-term fix)

As the review indicates:

- **Deny list:** add the leaked term (or its normalized shape) to the redaction deny
  list so both the primary layers and the residual scan catch it.
- **Redaction corpus:** add an adversarial fixture reproducing the miss to the redaction
  corpus, so recall gating catches a regression of this shape.
- **Extractor prompt:** if the extractor selected or reconstructed risky text from a
  clean transcript, tighten the extraction prompt's verbatim-phrase rules and bump the
  prompt version.
