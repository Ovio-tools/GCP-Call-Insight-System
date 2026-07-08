# ADR 0008 — Verbatim gate: snap near-verbatim phrases to the source, drop only fabrications

Status: accepted (issue #63, 2026-07-08). Refines the extract verbatim gate
introduced in ADR 0003 and loosened for punctuation in issue #61 (PR #62).
Supersedes nothing; the residual-PII gate and its PII precedence are unchanged.

## Context

The extract stage requires each `customer_language` phrase to be a real quote
of the redacted text — the guarantee that keeps stored quotes free of
model-invented content that never passed redaction. ADR 0003 enforced this as a
whole-record gate: any non-verbatim phrase held the entire record
(`schema_invalid`). ADR 0007 added one bounded retry; issue #61 (PR #62) made
the check tolerant of benign punctuation/case/apostrophe/whitespace differences.

The first 25-call staging run (2026-07-08) still ended with one call held: on
both attempts exactly one of its 5–7 phrases differed from the source at the
WORD level (a light paraphrase, e.g. `there's` for `there is`, an inserted
`really`). Issue #61 correctly does not admit that — but holding an entire,
otherwise-valid record because ONE quote was reworded is heavier than the harm
warrants: the other phrases are faithful, and the `tokenGate` one line down
already drops individual bad phrases rather than holding.

Accepting a "highly similar" phrase _as the model wrote it_ was rejected: it
would store text that never went through redaction, breaking the exact-source
guarantee. Semantic/embedding similarity was also rejected: it rates paraphrases
as near-identical, defeating the faithfulness purpose, and it is non-deterministic
and adds a network dependency to a pure gate.

## Decision

The verbatim gate becomes a **filtering, snap-to-source** gate:

1. **Exact** (substring after `normalizeForVerbatim`, issue #61) → kept as-is.
   The exact check runs FIRST, so issue #61's punctuation tolerance is preserved
   unchanged and only previously-failing phrases enter the new path
   (precision-neutral: we only act where the system holds today).
2. **Near** a real span → the phrase is **snapped**: replaced with the matched
   **source span**, an exact substring of the redacted text — never the model's
   text. Nearness is a deterministic **word-level LCS similarity** over normalized
   words, sliding windows of length m-1/m/m+1 (one insertion/deletion tolerated);
   similarity = LCS / max(phraseLen, windowLen). Threshold
   `SNAP_MIN_SIMILARITY = 0.7`: a single reworded word in a 4+-word phrase scores
   ~0.75 (snaps); a 2-word phrase with one word changed scores 0.5 (drops); a
   fabrication scores near 0. A fixed, tested constant — a knob would only
   institutionalize drift (same stance as ADR 0007's mirror constants).
3. **Far** from every span → **dropped** (likely fabricated).

Handler flow: a non-exact result still takes the ONE bounded ADR 0007 retry
FIRST (the model often re-quotes exactly, needing no snap). Once the retry is
spent, the stage **proceeds on the recovered set** — persisting exact + snapped
phrases — and holds `schema_invalid` **only if nothing verbatim remains** (every
phrase un-locatable). Snap/drop counts are recorded for observability
(`customer_language_snapped` / `customer_language_dropped`), counts only.

## Invariants preserved

- **Exact-source guarantee:** every persisted phrase is an exact substring of the
  redacted text (exact match, or a sliced source span). We never store the model's
  paraphrase.
- **PII precedence unchanged:** the residual-PII scan runs on the phrases FIRST; a
  phrase with residual PII still hard-holds `residual_pii_detected` regardless of
  snapping. A snapped span is a substring of the already-scanned redacted text, and
  the downstream second PII scan (`verbatim-pii-scan`) re-checks the persisted set.
- **Second-scan latch is stricter, not looser:** `verbatim-pii-scan` still asserts
  every PERSISTED phrase is EXACT (it never snaps); a non-exact persisted phrase
  latches `verbatim_mismatch` → `schema_invalid`, as before.
- **Alerting:** a completed call is not a failure path — snapping/dropping while
  completing emits no alert. The `MODEL_MALFORMED_RESPONSE` alert fires only when
  the record holds (all phrases un-locatable), still once per failure.

## Consequences

- The `5042…`-type call (one reworded quote) now completes with its faithful quotes
  recovered as real source spans, instead of holding for a human.
- A wrong snap stores a real-but-possibly-less-relevant customer quote (low harm,
  still PII-safe), which the conservative 0.7 threshold makes rare.
- Only wholesale-fabricated `customer_language` (every phrase far from the source)
  still holds `schema_invalid`.
