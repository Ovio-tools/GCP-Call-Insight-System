# ADR 0007 — Primary layers as a strict superset of the residual scan; bounded extract retry

Status: accepted (Task 4.1c, 2026-07-08). Builds on ADR 0002 (redaction
tokens + fail-closed) and ADR 0006 (NER entity scope + confidence gating);
neither is superseded.

## Context

After ADR 0006 eliminated NER over-redaction, the four consented staging calls
(PR #58) showed the residual scan doing exactly its job — and that being the
problem: 3 of 4 calls held on GENUINE primary-layer recall gaps, not false
positives. Two held `digit_run` (a bare 7-digit local number `xxx-xxxx`, and a
4+4 digit pair joined across a transcript line boundary — neither fits the
NANP, digit-by-digit, Luhn, or SSN/EIN shapes). One held
`vault_value_reintroduced` (a name vaulted from one occurrence survived
elsewhere as a punctuation-split "…Mister David? Rolando."). The fourth passed
redaction and then held at extract on `MODEL_MALFORMED_RESPONSE`.

A residual hold means a human reads a raw transcript. When the hold is caused
by PII the primary layers _could_ have redacted, the fail-safe posture costs
review time without adding safety — the value should have been tokenized, not
escalated.

## The superset principle

**Every category the residual scan can hold on must have a primary layer that
catches it FIRST.** The residual scan itself stays BYTE-FOR-BYTE UNCHANGED as
the independent auditor: it still runs over the final output, on its own code
path, with its own deliberately stricter-and-dumber rules. Borrowing its rules
into the primary layers does not weaken the audit — the audit still verifies
the final artifact. Residual sensitivity and `REDACTION_RISK_THRESHOLD` are
never lowered to raise pass rates.

**Precision neutrality** is the governing property of everything below: each
addition mirrors a residual sub-scan, so any text it newly redacts is text
that — had it survived to the output — would have residual-HELD the call
today. The changes convert holds into redactions; they cannot touch a call
that passes today. (This extends the ADR 0006 philosophy: the fix for
self-defeating fail-safety is precision, not sensitivity reduction.)

## Decision 1 — the residual-mirror repair fixpoint

Detectors over the ORIGINAL text can never dominate the residual scan on
their own, because the residual scans the OUTPUT, where token-stripping
(`[NAME_1]` → `' '`) concatenates content across redacted spans:
`"123456 Bob 654321"` contains no 7-digit run until Bob is redacted;
`"my name is <deny-term> Rodriguez"` has no greeting shape until the deny
term is removed.

So the guarantee lives in a repair loop inside the ONE shared composition
(`src/redaction/compose.ts`, used identically by the stage handler, the CI
gate harness, and the inspection tool). After merge+tokenize,
`src/redaction/repair.ts`:

1. builds the **effective text** — the original with every covered span
   replaced by a single space, exactly equal to the output with tokens
   stripped (the residual's view);
2. runs the **mirror finders** (`src/redaction/mirror-finders.ts`) over it —
   offset-producing ports of the residual sub-scans: digit runs (≥7 digits
   ignoring non-alphanumerics, including line boundaries), spelled-digit runs
   (oh/double/triple automaton), greeting-cue names, email shapes (confusable
   at-signs, mixed spoken), deny-term collapsed-substring occurrences,
   vault-value reintroductions (≥3 normalized chars floor; 3–7 chars
   word-boundary, ≥8 collapsed), and address-window digits;
3. maps hits back to original-text spans (dropping already-covered ones),
   re-merges, re-tokenizes, and repeats;
4. exits only when a pass finds nothing AND the residual's own exported
   `isVaultValueReintroduced` predicate is clean for every vault entry.

**Sharing note** (required by the residual module's independence header): the
mirrors are DUPLICATED, not imported — residual-scan.ts is unchanged and its
private rules stay private. Two exceptions, both already-public API: the token
shape `TOKEN_PATTERN` (pre-existing) and the `isVaultValueReintroduced`
predicate (already exported for the inspection tool), used here only as the
fixpoint's exit post-condition, not as detection logic. Drift between mirror
and residual is pinned by two CI tripwires: a fire/no-fire parity suite
(mirror vs the real `residualScan`, per category) and the superset gate below.

**Termination**: every firing iteration strictly increases the count of
covered characters (fully-covered hits are dropped before merging), bounded by
text length. The iteration cap (10) is a backstop; a cap-hit returns
`converged: false`, the composition proceeds, and the unchanged residual scan
holds the call — fail closed, with `residual_pii_detected` semantics identical
to today.

**Vault propagation detail**: a propagated occurrence carries the SAME entity
type as the original vault entry, so the tokenizer's
`entityType + normalized-surface` key coalesces it onto the SAME per-call
token — no new vault entries, no renumbering, idempotent reruns.

## Decision 2 — new primary detectors (regex layer)

These catch the common contiguous cases up front with specific entity types;
the repair loop remains the by-construction guarantee for the
cross-span-concatenation cases.

- **Generic long number** — new EntityType `'number'` → `[NUMBER_n]`: any run
  of ≥7 digits where only non-alphanumerics intervene (mirror of `digit_run`).
  Candidates fully covered by a phone/credit-card/government-id detection are
  suppressed so specific shapes keep their tokens. Long non-PII numbers
  (order/invoice/serial ids) being redacted is accepted over-redaction — such
  a run surviving today residual-holds the call anyway. No DB migration:
  `redaction_findings.entity_type` is free text; `TOKEN_PATTERN` already
  matches the new label.
- **Spelled-out digit runs** — the residual automaton (zero/oh/one…nine,
  double/triple multipliers, run ≥7) as a detector emitting `'phone'` spans.
  The corpus/adversarial fixtures that previously could only `expectHold`
  (phone-07/08, adv-phone-spoken-mixed, adv-phone-double) are now normal
  caught-by-redaction cases. "Seventy eight degrees" / "ten minutes" have no
  7-run of digit words and never fire.
- **Greeting-cue names** — capitalized run after `my name is` / `ask for` /
  `speaking with`, or a capitalized bigram after `this is` / `it's`, emitting
  `'name'` spans. The deterministic backstop for names the ADR 0006 confidence
  gate drops. The capture is GREEDY (1..n strong, 2..n weak) where the
  residual matches only one/two tokens — deliberately: if only a prefix of a
  long name were redacted, the stripped output (`"my name is  Damme"`) would
  still match the residual's cue regex (its `\s+` spans the token gap) and
  hold. Lowercase after the cue ("this is regarding the invoice", "ask for the
  manager") never fires — pinned in precision fixtures.
- **Email shapes** — the residual-only acceptances added to `detectEmails`:
  Unicode confusable at-signs (`＠`, `﹫`) and the mixed spoken form
  ("john at gmail.com" — spoken _at_, literal dot).

## Decision 3 — address_like is dominated too (data-controller sign-off, 2026-07-08)

The residual `address_like` rule (an address keyword — street, avenue,
boulevard, address, apartment, apt, suite, zip — with ANY digit within 40
chars of the output) fires on non-PII prose ("the zip code is 95814" when no
layer redacts bare zips). Rather than leave it a live hold class, the repair
loop redacts the digit run(s) inside the residual's exact keyword window
(as `'number'` spans; the keyword itself always survives). Digits near an
address keyword are plausibly address components (zip, house, apartment
numbers), and per precision neutrality the affected calls all hold today —
the occasional harmless number near "street" being tokenized is the accepted
cost of the call flowing at all. Window shrinkage after redaction can pull new
digits into range; the fixpoint's next iteration catches them.

## Scope of the guarantee

All seven residual categories are dominated: `vault_value_reintroduced`,
`digit_run`, `spelled_out_digits`, `email_like`, `name_like_after_greeting`,
`deny_list_term` (via a collapsed-substring mirror in the repair loop — the
primary deny-list detector keeps its precision-friendly whole-word semantics),
and `address_like`. **The only remaining `residual_pii_detected` path is
repair-cap exhaustion** (`converged: false`), which no known input reaches.
CI enforces this: the superset gate in `corpus-recall.test.ts` and
`adversarial.test.ts` asserts that no dominated category appears in ANY case's
final residual counts, against the real vendored NER model. The stage's
residual-hold branch stays covered by tests that inject a no-repair
composition (simulating cap exhaustion).

Consequences of repair-added spans: `deriveSpanSignals` may see higher span
density and repair/detector overlaps may set `detector_disagreement` (both
weight 0.1, non-forced, safe) — only on calls that would otherwise HOLD, so
the outcome is strictly better; documented rather than suppressed. NER is
never re-run inside the loop — iterations are regex/string work plus
re-tokenization.

## Decision 4 — bounded extract output-badness retry

On a retryable parse failure — `empty`, `non_json`, `schema_invalid`,
`unexpected_stop_reason`, with usage present — **or a verbatim-gate mismatch**
(schema-valid output whose `customer_language` phrases are not exact quotes;
staging showed this is the dominant real-world `MODEL_MALFORMED_RESPONSE`
shape, including the original 4957646123024384 hold), the extract stage makes
exactly ONE re-attempt TOTAL per call before holding `schema_invalid`. After a
verbatim-triggered retry, ALL gates re-evaluate once on the new output with
PII precedence preserved (a residual-PII hit in phrases is never retried or
re-sent). Excluded on purpose:
`refusal` (deliberate model behavior; a "fix your JSON" nudge is wrong),
`truncated` (identical params give a near-identical result; the retry burns a
full reservation for nothing), and usage-missing (a billing anomaly, not
output badness — the kept reservation is the remedy).

- **Feedback is content-free**: the retry user message is the ORIGINAL message
  (transcript included) plus a fixed per-kind description and, for
  `schema_invalid`, a summary built from zod issue `path` + `code` ONLY —
  never `message`, which can embed received values; for a verbatim mismatch,
  mismatch/phrase COUNTS only — never the phrases. The summary exists solely
  in the outbound request (egress-safe: it derives from the model's own
  response to already-redacted input) and is never logged, alerted, or
  persisted.
- **Accounting**: each attempt has its own reserve → record → settle cycle;
  both invocations land in `model_invocations` (record-before-route). A
  second reservation the daily cap rejects SKIPS the retry and holds
  `schema_invalid` with `detail.retry_skipped: 'cost_cap'` — model badness
  stays the reviewable fact, never converted to a spurious `cost_cap_held`.
  Worst case is two full reservations per call, still under the daily cap
  gate. The SDK's `maxRetries: 0` is untouched.
- **Alerting**: `MODEL_MALFORMED_RESPONSE` fires only on the FINAL failure —
  one actionable alert per failure path; a retried-then-valid response alerts
  nothing (the attempt-1 `malformed_response` invocation row remains the
  diagnostic).
- `EXTRACT_PROMPT_VERSION` bumped to `extract-v2`: the retry suffix joins the
  prompt template family, and both attempts record under it.

## No new configuration

The mirror constants (run length 7, reintroduction floors 3/8, the 40-char
address window, the greeting cues) are correctness-fixed to the residual's
values — a knob would institutionalize drift. The retry count is a literal 1
under the existing `EXTRACT_ENABLED` kill switch and daily cost cap. No
migration.
