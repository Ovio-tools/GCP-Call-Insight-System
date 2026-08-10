# ADR 0010 — An emergency is a label, not a hold

Status: accepted
Date: 2026-08-10
Relates to: ADR 0003 (extract schema gate, deterministic urgency, no scores — **superseded in
part**), ADR 0004 (held-call retention and review SLA)

## Context

ADR 0003 §3 made two decisions in one breath. The first: `urgency` is set by a deterministic rule
(`emergencyRule`), never by the model rating its own output. The second: when that rule reaches
`emergency`, the call is HELD — parked in the review queue as `emergency_review` with the strictest
SLA in the system (15 minutes), so a person sees it fast.

The first decision was right and stands. The second was built on a premise that does not hold for
this system.

This pipeline is **downstream of the live call**. It ingests calls that have already ended: the
dispatcher spoke to the customer, heard "I smell gas", and dispatched — or did not — while the
customer was on the phone, hours or days before this pipeline ever sees the transcript. Its purpose
(build plan §1) is to build a de-identified knowledge base out of finished calls.

So the emergency hold could never have been a safety net. There is no emergency to catch by the
time the rule fires. What it did instead was measurable and entirely negative:

- A correctly extracted, PII-clean record was kept OUT of the knowledge base until a person
  clicked approve — the exact records most worth having.
- Each one started a 15-minute clock nobody could meaningfully answer, so it breached its SLA and
  emitted a `REVIEW_QUEUE_STALLED` escalation for an event already resolved.
- An open review row blocks the CLEAN retention group (`cleanBlocking`, `src/retention/purge.ts`),
  so redacted text and the extraction candidate sat past their normal window — the hold quietly
  EXTENDED PII retention in exchange for nothing.

## Decision

**`emergencyRule` labels; it does not route.** It keeps every tier exactly as ADR 0003 §3 describes
— the EMERGENCY tier (model's own `urgency`, `call_intent`, or a fixed keyword such as "gas
leak"/"carbon monoxide"/"burst pipe") overriding urgency UP, and the AMBIGUOUS tier upgrading one
level — and the ladder is still derived by reversing the `URGENCY` enum. Only the hold is gone.

The invariant is enforced by the type, not by convention: `emergencyRule` returns
`{ urgency, triggers }` with **no `hold` field**, so the hold cannot be reintroduced without
changing the signature. `grep -rn "emergency_review" src/pipeline/` returns nothing.

An escalated call now advances like any other, and its `triggers` ride along on the extract stage's
`processing_log` `continue` row as `urgency_triggers` — constant snake_case ids only, never the
matched text — so the reason the stored urgency differs from the model's rating stays auditable.

**The `emergency_review` held reason is retained, deliberately.** It stays in `HELD_REASON`, in the
Postgres `held_reason` enum, in `REVIEW_SLA_MINUTES_BY_REASON` (including its strict-minimum rule),
and in the review surface's action matrix, explanations, and labels. Rows held before this change
must stay resolvable — `approve` still resumes them at `verbatim-pii-scan`, where their already-
persisted candidate picks up. No migration, no config change.

## Consequences

- Emergency and ambiguous-tier calls reach `structured_knowledge` with `urgency = 'emergency'` /
  `'urgent'` and are findable through the existing `/knowledge` and `/notes` urgency filters. The
  urgency signal is now MORE useful, not less: it is on the record instead of gating it.
- The review queue narrows toward its real job — calls the system genuinely could not resolve
  (`classifier_uncertain`) and calls where storing anything would be unsafe (`redaction_failed`,
  `residual_pii_detected`, `schema_invalid`, `malformed_model_output`, `missing_transcript`,
  `cost_cap_held`). **None of those changed**; `classified_spam` still routes to a person too.
  `test/pipeline/extract/emergency.test.ts` carries an explicit scope guard: a schema-invalid
  record with the same emergency keyword still holds.
- Pre-existing `emergency_review` rows keep breaching their 15-minute SLA and escalating until a
  person clears them in `/review`. That was accepted as the cost of not force-closing real rows.
- If a genuine post-call escalation need ever appears (say, an emergency that the dispatcher
  demonstrably missed), the answer is a targeted alert or a report over the stored `urgency` — not
  a pipeline hold. Holding is for calls the pipeline cannot safely finish.

## Alternatives considered

**Remove `emergency_review` from the enum.** Rejected. Postgres cannot drop an enum value, so it
means the rename/recreate/re-type rebuild across all three `held_reason` columns (`review_queue`,
`labeled_examples`, `labeled_example_rejections`), and it would strand the rows already in the
queue. The type-level removal of `hold` gives the same "cannot be produced again" guarantee at zero
migration risk.

**Keep the hold but stretch its SLA.** Rejected. It treats the symptom (noisy escalations) and
keeps the real cost — good records withheld from the knowledge base and PII retention extended.
