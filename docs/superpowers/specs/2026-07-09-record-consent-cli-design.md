# Design: `record-consent` CLI

**Date:** 2026-07-09
**Status:** Approved (brainstorming)
**Author:** launch-readiness work

## Problem

The §0.2 launch gate requires that the five processing consents —
recording consent, signed services agreement, signed data-processing addendum,
Anthropic no-training confirmation, and Anthropic data-retention confirmation —
be **recorded as rows in the `consent_gates` table** before any live processing.

These consents are confirmed in the real world, but the ledger is empty: the code
that guards live processing (the sample-validation harness in
`src/sample-validation/gates.ts` and the backfill runner in `src/backfill/gates.ts`)
only trusts a row in `consent_gates`, and no such rows exist. The only write helper
(`recordConsent` in `src/db/repositories/consent-gates-repo.ts`) is called only by
tests; the documented process is a human running raw SQL, which is unsafe and
un-audited for a compliance record.

This design adds a checked, auditable operator command to record a consent gate,
replacing hand-written SQL.

## Goals

- Give an operator one supported command to record a §0.2 consent gate.
- Prevent the two ways a hand-written row goes wrong: a mistyped `gate_type` that
  never satisfies the gate check, and a duplicate audit row from a re-run.
- Require a human-readable evidence note on every gate.
- Reuse the existing write path (`recordConsent`); add no new SQL or DB access path.

## Non-goals

- The command does not run against the production database in this development
  session. The operator runs it against the real database with real notes.
- No change to the gate-check logic, the schema, or any migration.
- No UI / HTTP surface. This is a CLI, consistent with the other operator scripts.

## Interface

A new script `src/scripts/record-consent.ts`, wired as `npm run record-consent`,
following the existing script pattern (e.g. `src/scripts/mark-sample.ts`).

One gate per invocation:

```
npm run record-consent -- --gate <gate_type> --by "<name>" --note "<one-line note>"
```

Example:

```
npm run record-consent -- \
  --gate dialpad_recording_consent \
  --by "Jane Doe" \
  --note "Eric confirmed recordings in writing, email 2026-06-30"
```

### Flags

| Flag     | Required | Maps to               | Rules                                                     |
| -------- | -------- | --------------------- | -------------------------------------------------------- |
| `--gate` | yes      | `consent_gates.gate_type`    | Must be one of the canonical gate types (below).   |
| `--by`   | yes      | `consent_gates.recorded_by`  | Non-empty after trim.                              |
| `--note` | yes      | `consent_gates.evidence_ref` | Non-empty after trim. Stricter than the nullable schema — deliberate. |
| `--force`| no       | —                     | Insert a second row even if the gate is already recorded. |

### Canonical gate types

The command validates `--gate` against the vocabulary already defined in
`src/sample-validation/gates.ts` — it imports those constants rather than
re-declaring them, so the CLI and the gate-check can never drift:

- `dialpad_recording_consent`
- `signed_services_agreement`
- `signed_data_processing_addendum`
- `anthropic_no_training_confirmation`
- `anthropic_data_retention_confirmation`
- `servicetitan_matching_consent` (conditional; only needed if ServiceTitan
  write-back is in scope, but the command accepts it so the same tool records it)

Any other value is rejected before any database write, with a message listing the
allowed values.

## Behaviour

1. Parse and validate flags. On a bad/unknown `--gate`, empty `--by`, or empty
   `--note`, print a clear error and exit non-zero. No DB write.
2. **Idempotency:** query the gate type via the existing `listByType`. If a row
   already exists and `--force` is not set, print `already recorded` (with the
   existing row's `recorded_by` / `recorded_at`) and exit 0 without inserting.
3. Otherwise insert via `recordConsent(pool, { gateType, recordedBy, evidenceRef })`.
4. **Report:** print the recorded gate (type, recorded_by, note, recorded_at), then
   print a summary of which of the five required processing gates are still missing,
   using `checkProcessingGates`, so the operator knows when the launch gate is clear.
5. Close the pool and exit.

The command uses the main database pool (DB-A). `consent_gates` is low-sensitivity
and lives in the main DB, not the isolated raw store (DB-B).

## Error handling

Argument and validation errors print a plain-language message and exit non-zero;
they do not produce a stack trace. Database errors propagate through the existing
`recordConsent` / pool error paths. No consent-specific failure-model code is
introduced — this is an operator tool, not a pipeline stage.

## Testing

- **Unit** (no DB): argument parsing and validation — unknown `--gate` rejected,
  empty `--by` rejected, empty `--note` rejected, valid args parse to the expected
  insert shape. The arg-parsing/validation logic is factored into a pure function so
  it can be tested without a database or process spawn.
- **Integration** (test database, using the same DB-test harness as the existing
  consent tests, e.g. `test/db/sample-validation-gates.test.ts`):
  - a valid run inserts exactly one row of the right type;
  - a second run of the same gate without `--force` inserts nothing (idempotent);
  - `--force` inserts a second row;
  - the "still missing" summary reflects recorded vs. unrecorded gates.

## Files

- `src/scripts/record-consent.ts` — new CLI entrypoint + pure arg-parse/validate
  helper.
- `package.json` — add the `record-consent` script.
- `test/scripts/record-consent.test.ts` (or `test/db/…`) — unit + integration tests.
- No migration. No schema change. No change to `gates.ts`, `recordConsent`, or any
  pipeline/gate-check code.
