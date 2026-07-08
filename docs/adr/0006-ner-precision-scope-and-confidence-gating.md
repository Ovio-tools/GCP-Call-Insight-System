# ADR 0006 — NER precision: entity-type scope + confidence gating

Status: accepted (Task 4.1 follow-up, 2026-07-07). Supersedes ADR 0002 §2
("Every NER candidate span is redacted, regardless of confidence") and narrows
ADR 0002 §1's redact-all-types behavior.

## Context

The first real staging calls (inspected with `src/scripts/inspect-redaction.ts`
on four consented trade-service calls) showed the NER layer redacting large
amounts of NON-PII: places, rooms, and fixtures ("Texas", "office", "bathroom",
"kitchen", "pool", "water heater", "AC system"), function words ("I", "of",
"ten", "right"), and sub-word fragments ("lea", "val window", "Bathroom tu").
Because those common words repeat within a transcript, every vaulted surface
re-appeared elsewhere in the output and triggered the residual scan's
`vault_value_reintroduced` — a forced hold. **Every real call held**, not from
missed PII but from redacting far too much. 100% hold means humans read every
raw transcript: the fail-safe posture of ADR 0002 §2 had become self-defeating
for the privacy boundary it exists to protect.

Root causes, all in `src/redaction/ner-detector.ts`:

1. `LABEL_MAP` redacted ALL CoNLL types — PER, LOC, ORG, and MISC — and
   conversational trade text is dense in exactly the LOC/ORG/MISC shapes that
   are not personal data.
2. Every candidate span was redacted regardless of confidence
   (`REDACTION_NER_MIN_SCORE` only raised a signal), so low-confidence junk and
   fragments were vaulted.
3. The title-cased second pass (added for lowercase-name recall) promotes
   common nouns into proper-noun shapes ("bathroom" → "Bathroom"), which the
   cased model then tags as entities.
4. The contiguity merge over wordpieces produced fragment spans that cut words
   in half.

## Decisions (data-controller sign-off, 2026-07-07)

### 1. NER redaction is scoped to PERSON + numbered locations by default

`REDACTION_NER_ENTITY_SCOPE` (CSV, default `person,numbered_location`) controls
which NER detection types are redacted at all:

- `person` — PER spans. Names are the PII class only the NER layer can catch.
- `numbered_location` — a LOC span is redacted ONLY when a house-style number
  (1–6 digits, not the tail of a longer digit run) immediately precedes it
  separated by horizontal whitespace only (`numberedLocationPrefix`). This
  catches suffix-less street addresses ("4482 Kensington Meadows") that the
  regex address grammar cannot (no street suffix). The span is widened to
  include the number so it is vaulted with the location. Anchoring on the span
  start means "we have 2 units in Roseville" does NOT fire; "2 Roseville
  properties" DOES fire and is accepted over-redaction — a bare number
  immediately before a place name is exactly the surface form of a suffix-less
  address, and no lexicon can distinguish them.
- `location` / `organization` / `misc` — opt back in to the pre-ADR-0006
  redact-everything behavior per type, via config alone.

Policy rationale: bare city names and business names are not personal data for
this pipeline's purpose; structured location PII (street addresses,
cross-streets) is always covered by the regex layer regardless of this scope,
and the config deny-list remains the escape hatch for specific sensitive names.
The recall-gate corpus was split accordingly: the bare-LOC/ORG cases moved from
`corpus.json` (asserted redacted) to `precision.json` (asserted NOT redacted
and NOT held) — `test/redaction/precision.test.ts` is the new mirror gate.

### 2. Sub-threshold candidates are dropped — a deliberate fail-safe relaxation

Spans with mean confidence below `REDACTION_NER_MIN_SCORE` are DROPPED, not
redacted. This inverts ADR 0002 §2 knowingly:

- Before: every candidate tokenized; the threshold was advisory.
- After: a sub-threshold candidate remains in the output, and the detector
  raises `ner_low_confidence` — whose meaning inverts with it: it now marks "a
  suspected-entity surface remains un-redacted", so its safety classification
  changed from `safe_after_redaction` to `unsafe_uncertain_surface` (a held
  call no longer keeps a `clean_transcripts` row whose text contains a dropped
  suspect surface). It is no longer derived in `deriveSpanSignals` — the
  detector is its single source.

Why acceptable: the measured false-positive rate made the old behavior
self-defeating (every call held ⇒ zero throughput ⇒ humans reading raw
transcripts). The regex layer, deny list, residual scan (greeting-cue name
shapes, digit runs, address keywords), and the risk-score hold path all remain
independent backstops for what the gate drops.

### 3. Title-case-pass detections count only for PERSON

The second (title-cased) pass exists solely for lowercase-name recall; its
LOC/ORG/MISC hits are overwhelmingly promoted common nouns. Its non-PER spans
are discarded unconditionally (not configurable — opting `misc` back in still
never resurrects title-case-pass MISC junk). Across passes, duplicate spans
keep the HIGHEST confidence (previously lowest), because with a drop-gate the
correct survival criterion is "confidently found in either pass" — lowercase
names score high only in the title-cased pass.

### 4. Spans snap to whole-word boundaries; confidence is the wordpiece mean

`alignTokens` snaps every emitted span outward to word boundaries (word chars
`[A-Za-z0-9'’-]`, so "D'Angelo", "Gonzalez-Ruiz", "Raley's" stay whole);
snapping only widens (fail-safe) and never moves the alignment cursor.
Per-span confidence changed from min to MEAN of wordpiece scores: with a drop
gate, one weak `##` continuation piece must not delete a real multi-word name.

## Tuning record (2026-07-07, real vendored model, quantized q8)

Measured with full scope + `minScore: 0` over `corpus.json`,
`adversarial.json`, `precision.json`, and lowercase junk sentences
(scratchpad `tune-minscore.ts`; distributions reproducible from the committed
fixtures):

- Weakest full-value labeled NAME span needed by the recall gate:
  "Esperanza Villanueva" **0.7614** (then "D'Angelo Harris" 0.7959,
  "Katarzyna Wojcik" 0.8111, lowercase "sarah jane mccormick" 0.8255).
  Lowercase "kevin oconnor" scores 0.9806 via the title-case pass + max-dedup;
  its redundant original-pass shard "oconnor" (0.5629) is not needed.
- "Kensington Meadows" (the numbered-LOC regression case, `adv-addr-no-suffix`)
  scores **0.9281** — clears the gate with a wide margin; no gate bypass for
  adjacency-qualified spans was needed.
- The lowercase junk sentences produced ZERO candidates at any threshold once
  scope + the PER-only title pass applied — the gate's remaining job is
  low-confidence PER shards.
- Default frozen at **0.7**: the highest round value keeping ≥ 0.05 recall
  margin under 0.7614. Mean aggregation kept (validated against the gates; min
  would put multi-word names below the bar via one weak piece).

## Known residual gaps (accepted)

- **All-lowercase suffix-less addresses** ("4482 kensington meadows"): the
  title-case pass is PER-only and the regex `ADDRESS_LIKE` ambiguity signal is
  capital-anchored, so neither layer fires. Candidate follow-up: a
  case-insensitive numbered-phrase variant in the regex layer.
- **Bare cities / business names now egress by design** — that is the
  signed-off policy, restated here so it is not re-litigated per incident.
- Real-world name shapes weaker than the corpus floor (unusual names in
  atypical syntax) may score below 0.7 and drop; the residual scan's
  greeting-cue check and the review path remain the backstops. Revisit the
  threshold with staging data if `ner_low_confidence` holds cluster.

## Consequences

- Real staging calls stop holding on `vault_value_reintroduced` junk; vaults
  shrink to plausible person/address surfaces (validated on the four consented
  staging calls — see the Task 11.1 sample-validation re-run).
- `[LOCATION_n]`/`[ORGANIZATION_n]`/`[OTHER_n]` tokens become rare under the
  default scope. Token vocabulary, findings schema, and vault are unchanged; no
  migration. Stale vault rows from prior runs are inert and purge with raw.
- Widened numbered-LOC spans can overlap regex address spans →
  `detector_disagreement` (weight 0.1, safe) may fire more often; harmless.
- A held call that also dropped a low-confidence candidate loses its clean row
  (reviewers read raw for those) — strictly safer, slightly more review
  friction.
- Existing review-queue holds from the over-redaction era are untouched; a
  broader requeue of `residual_pii_detected` holds is an operational follow-up.
