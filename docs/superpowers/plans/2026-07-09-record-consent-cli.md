# record-consent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checked, auditable operator command (`npm run record-consent`) that records a §0.2 consent gate into the `consent_gates` table, replacing hand-written SQL.

**Architecture:** A single new script `src/scripts/record-consent.ts` exposes three things: a pure `parseRecordConsentArgs` (arg parsing/validation, no DB), a `runRecordConsent(pool, input)` orchestrator (idempotency check + insert via the existing `recordConsent` helper + a "still missing" summary via the existing `checkProcessingGates`), and a thin `main()` that wires config → pool → orchestrator → operator-facing output. No new SQL, no schema/migration change, no change to the gate-check code. Unit tests cover arg parsing without a database; integration tests cover the orchestrator against the test database.

**Tech Stack:** Node.js + TypeScript (strict, `exactOptionalPropertyTypes`), `pg`, vitest, pino (via `createBootLogger`). Reuses `src/db/repositories/consent-gates-repo.ts` and `src/sample-validation/gates.ts`.

---

## File Structure

- **Create** `src/scripts/record-consent.ts` — CLI entrypoint. Exports `ALLOWED_GATE_TYPES`, `parseRecordConsentArgs`, `runRecordConsent`, `main`, and the supporting types. Single responsibility: record one consent gate safely.
- **Create** `test/scripts/record-consent-args.test.ts` — unit tests for `parseRecordConsentArgs` (no DB; always runs).
- **Create** `test/db/record-consent.test.ts` — integration tests for `runRecordConsent` (skips when no test DB, like the other consent tests).
- **Modify** `package.json` — add the `record-consent` script.
- **Modify** `docs/demo-sample-validation-railway.md` — replace the "hand-write the SQL" step with the new command.

Reused, unchanged:
- `src/db/repositories/consent-gates-repo.ts` — `recordConsent`, `listByType`.
- `src/sample-validation/gates.ts` (re-exported via `src/sample-validation/index.ts`) — `REQUIRED_PROCESSING_GATE_TYPES`, `SERVICETITAN_MATCHING_CONSENT_GATE`, `checkProcessingGates`.
- `src/config/index.ts` (`loadConfig`), `src/boot/logger.ts` (`createBootLogger`), `src/db/index.ts` (`createAppPool`).

**Design note (do not add):** unlike `mark-sample.ts`, this command must NOT call `assertStagingResources` — recording production consent is a production action, and a staging guard would defeat its purpose.

---

### Task 1: The pure arg parser

**Files:**
- Create: `src/scripts/record-consent.ts`
- Test: `test/scripts/record-consent-args.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `test/scripts/record-consent-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALLOWED_GATE_TYPES, parseRecordConsentArgs } from '../../src/scripts/record-consent.js';

describe('parseRecordConsentArgs', () => {
  const base = [
    '--gate',
    'dialpad_recording_consent',
    '--by',
    'Jane Doe',
    '--note',
    'email 2026-06-30',
  ];

  it('parses a valid full invocation', () => {
    expect(parseRecordConsentArgs(base)).toEqual({
      gateType: 'dialpad_recording_consent',
      recordedBy: 'Jane Doe',
      note: 'email 2026-06-30',
      force: false,
    });
  });

  it('trims whitespace on values', () => {
    expect(
      parseRecordConsentArgs([
        '--gate',
        'signed_services_agreement',
        '--by',
        '  Jane  ',
        '--note',
        '  ref  ',
      ]),
    ).toMatchObject({ recordedBy: 'Jane', note: 'ref' });
  });

  it('parses --force', () => {
    expect(parseRecordConsentArgs([...base, '--force']).force).toBe(true);
  });

  it('rejects an unknown gate type', () => {
    expect(() => parseRecordConsentArgs(['--gate', 'nope', '--by', 'x', '--note', 'y'])).toThrow(
      /--gate must be one of/,
    );
  });

  it('rejects a missing --by', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--note', 'y']),
    ).toThrow(/--by/);
  });

  it('rejects an empty --note', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--by', 'x', '--note', '   ']),
    ).toThrow(/--note/);
  });

  it('treats a following flag as a missing value', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--by', '--note', 'y']),
    ).toThrow(/--by/);
  });

  it('accepts every canonical gate type', () => {
    for (const g of ALLOWED_GATE_TYPES) {
      expect(parseRecordConsentArgs(['--gate', g, '--by', 'x', '--note', 'y']).gateType).toBe(g);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && npx vitest run test/scripts/record-consent-args.test.ts`
Expected: FAIL — cannot resolve `../../src/scripts/record-consent.js` (module does not exist yet).

- [ ] **Step 3: Create `src/scripts/record-consent.ts` with the parser only**

```ts
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { createAppPool } from '../db/index.js';
import { listByType, recordConsent } from '../db/repositories/consent-gates-repo.js';
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
  checkProcessingGates,
} from '../sample-validation/index.js';

/**
 * Record a §0.2 consent gate in `consent_gates` (launch-readiness operator tool).
 *
 * One gate per invocation. Validates the gate name against the canonical vocabulary,
 * requires a human-readable evidence note, is idempotent (skips a gate already
 * recorded unless --force), and reports which required processing gates remain.
 *
 * Usage:
 *   npm run record-consent -- --gate <gate_type> --by "<name>" --note "<one-line note>"
 *   npm run record-consent -- --gate dialpad_recording_consent --by "Jane Doe" \
 *     --note "Eric confirmed recordings in writing, email 2026-06-30"
 */
export interface RecordConsentArgs {
  gateType: string;
  recordedBy: string;
  note: string;
  force: boolean;
}

/** The canonical gate vocabulary — the five §0.2 processing gates plus the conditional
 * ServiceTitan matching consent. Sourced from gates.ts so the CLI and the gate-check
 * can never drift. */
export const ALLOWED_GATE_TYPES: readonly string[] = [
  ...REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
];

export function parseRecordConsentArgs(argv: readonly string[]): RecordConsentArgs {
  const reqNonEmpty = (flag: string): string => {
    const i = argv.indexOf(flag);
    const raw = i >= 0 ? argv[i + 1] : undefined;
    if (raw === undefined || raw.startsWith('--')) throw new Error(`missing required ${flag}`);
    const trimmed = raw.trim();
    if (trimmed === '') throw new Error(`${flag} must not be empty`);
    return trimmed;
  };

  const gateType = reqNonEmpty('--gate');
  if (!ALLOWED_GATE_TYPES.includes(gateType)) {
    throw new Error(`--gate must be one of: ${ALLOWED_GATE_TYPES.join(', ')} (got "${gateType}")`);
  }
  const recordedBy = reqNonEmpty('--by');
  const note = reqNonEmpty('--note');
  const force = argv.includes('--force');
  return { gateType, recordedBy, note, force };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && npx vitest run test/scripts/record-consent-args.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/ovieoghor/gcp-call-insights-consent
git add src/scripts/record-consent.ts test/scripts/record-consent-args.test.ts
git commit -m "feat(consent): record-consent arg parser + gate validation"
```

---

### Task 2: The `runRecordConsent` orchestrator

**Files:**
- Modify: `src/scripts/record-consent.ts`
- Test: `test/db/record-consent.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/db/record-consent.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool } from './_pg.js';
import { listByType } from '../../src/db/repositories/consent-gates-repo.js';
import { runRecordConsent } from '../../src/scripts/record-consent.js';
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
} from '../../src/sample-validation/index.js';

describe.skipIf(!hasTestDb)('record-consent CLI (runRecordConsent)', () => {
  let pool!: Pool;
  const ALL = [...REQUIRED_PROCESSING_GATE_TYPES, SERVICETITAN_MATCHING_CONSENT_GATE];

  async function clearGates(): Promise<void> {
    await pool.query(`DELETE FROM consent_gates WHERE gate_type = ANY($1)`, [ALL]);
  }

  beforeAll(() => {
    pool = makePool();
  });
  beforeEach(clearGates);
  afterAll(async () => {
    await clearGates();
    await pool.end();
  });

  it('inserts exactly one row for a fresh gate', async () => {
    const res = await runRecordConsent(pool, {
      gateType: 'dialpad_recording_consent',
      recordedBy: 'Jane Doe',
      note: 'email 2026-06-30',
      force: false,
    });
    expect(res.inserted).toBe(true);
    expect(res.alreadyRecorded).toBe(false);
    const rows = await listByType(pool, 'dialpad_recording_consent');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recorded_by: 'Jane Doe', evidence_ref: 'email 2026-06-30' });
  });

  it('is idempotent — a second run without --force inserts nothing', async () => {
    const input = {
      gateType: 'signed_services_agreement',
      recordedBy: 'A',
      note: 'r1',
      force: false,
    };
    await runRecordConsent(pool, input);
    const res = await runRecordConsent(pool, { ...input, recordedBy: 'B', note: 'r2' });
    expect(res.inserted).toBe(false);
    expect(res.alreadyRecorded).toBe(true);
    expect(res.existingRecordedBy).toBe('A');
    const rows = await listByType(pool, 'signed_services_agreement');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recorded_by).toBe('A');
  });

  it('--force inserts an additional row', async () => {
    const input = {
      gateType: 'signed_data_processing_addendum',
      recordedBy: 'A',
      note: 'r1',
      force: false,
    };
    await runRecordConsent(pool, input);
    const res = await runRecordConsent(pool, { ...input, force: true, note: 'r2' });
    expect(res.inserted).toBe(true);
    const rows = await listByType(pool, 'signed_data_processing_addendum');
    expect(rows).toHaveLength(2);
  });

  it('reports which required processing gates remain missing', async () => {
    const res = await runRecordConsent(pool, {
      gateType: 'dialpad_recording_consent',
      recordedBy: 'A',
      note: 'r',
      force: false,
    });
    expect(res.missingProcessingGates).toEqual(
      REQUIRED_PROCESSING_GATE_TYPES.filter((g) => g !== 'dialpad_recording_consent'),
    );
  });

  it('reports no missing gates once all five are recorded', async () => {
    let res: Awaited<ReturnType<typeof runRecordConsent>> | undefined;
    for (const g of REQUIRED_PROCESSING_GATE_TYPES) {
      res = await runRecordConsent(pool, { gateType: g, recordedBy: 'A', note: 'r', force: false });
    }
    expect(res?.missingProcessingGates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/db/record-consent.test.ts`
Expected: FAIL — `runRecordConsent` is not exported from the script module.

- [ ] **Step 3: Add `runRecordConsent` (and its result type) to `src/scripts/record-consent.ts`**

Insert after `parseRecordConsentArgs` (before any `main`):

```ts
export interface RecordConsentResult {
  inserted: boolean;
  alreadyRecorded: boolean;
  existingRecordedBy?: string;
  existingRecordedAt?: Date;
  /** Required §0.2 processing gates not yet recorded (ServiceTitan consent excluded). */
  missingProcessingGates: string[];
}

/** Record the gate if new (or forced); otherwise report it as already recorded. Then
 * compute which required processing gates remain. Pure orchestration over the existing
 * repo + gate-check — no new SQL. */
export async function runRecordConsent(
  pool: Pool,
  input: RecordConsentArgs,
): Promise<RecordConsentResult> {
  const existing = await listByType(pool, input.gateType);
  const first = existing[0];

  let inserted = false;
  let alreadyRecorded = false;
  let existingRecordedBy: string | undefined;
  let existingRecordedAt: Date | undefined;

  if (first !== undefined && !input.force) {
    alreadyRecorded = true;
    existingRecordedBy = first.recorded_by;
    existingRecordedAt = first.recorded_at;
  } else {
    await recordConsent(pool, {
      gateType: input.gateType,
      recordedBy: input.recordedBy,
      evidenceRef: input.note,
    });
    inserted = true;
  }

  const { missing } = await checkProcessingGates(pool, { requireServiceTitanMatching: false });
  return {
    inserted,
    alreadyRecorded,
    ...(existingRecordedBy !== undefined ? { existingRecordedBy } : {}),
    ...(existingRecordedAt !== undefined ? { existingRecordedAt } : {}),
    missingProcessingGates: missing,
  };
}
```

Note: the conditional spreads are required by `exactOptionalPropertyTypes` — do not assign `undefined` directly to the optional fields.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/db/record-consent.test.ts`
Expected: PASS (5 tests). (If `TEST_DATABASE_URL` is unset, the suite skips — set it, per the local test DB convention.)

- [ ] **Step 5: Commit**

```bash
cd /Users/ovieoghor/gcp-call-insights-consent
git add src/scripts/record-consent.ts test/db/record-consent.test.ts
git commit -m "feat(consent): runRecordConsent orchestrator (idempotent insert + missing-gate summary)"
```

---

### Task 3: The `main()` entrypoint + package script

**Files:**
- Modify: `src/scripts/record-consent.ts`
- Modify: `package.json`

- [ ] **Step 1: Append `main()` and the entrypoint guard to `src/scripts/record-consent.ts`**

```ts
export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'record-consent' });
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const args = parseRecordConsentArgs(process.argv.slice(2));
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const result = await runRecordConsent(pool, args);
    if (result.alreadyRecorded) {
      logger.info({ gateType: args.gateType }, 'consent gate already recorded — no new row written');
      process.stdout.write(
        `Already recorded: ${args.gateType}\n` +
          `  first recorded by ${result.existingRecordedBy ?? 'unknown'} at ` +
          `${result.existingRecordedAt?.toISOString() ?? 'unknown'}\n` +
          `  (use --force to record an additional row)\n`,
      );
    } else {
      logger.info({ gateType: args.gateType, recordedBy: args.recordedBy }, 'consent gate recorded');
      process.stdout.write(
        `Recorded consent gate: ${args.gateType}\n` +
          `  recorded by: ${args.recordedBy}\n` +
          `  evidence:    ${args.note}\n`,
      );
    }
    if (result.missingProcessingGates.length === 0) {
      process.stdout.write(`\nAll five §0.2 processing consent gates are now recorded.\n`);
    } else {
      process.stdout.write(
        `\nStill missing ${result.missingProcessingGates.length} required processing gate(s):\n` +
          result.missingProcessingGates.map((g) => `  - ${g}`).join('\n') +
          '\n',
      );
    }
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`record-consent failed: ${String(err)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add the package script**

In `package.json`, in the `scripts` block, add this line next to `requeue:extract`:

```json
    "record-consent": "node dist/scripts/record-consent.js",
```

- [ ] **Step 3: Verify typecheck and build compile the new entrypoint**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && npm run typecheck && npm run build 2>&1 | tail -5 && ls dist/scripts/record-consent.js`
Expected: typecheck clean; build succeeds; `dist/scripts/record-consent.js` exists.

- [ ] **Step 4: Confirm the import guard — importing the module must not run `main()`**

The two test files already import from the module; re-run them to confirm importing does not trigger a DB connection or process exit:

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npx vitest run test/scripts/record-consent-args.test.ts test/db/record-consent.test.ts`
Expected: PASS (13 tests total), no hang, no "DATABASE_URL is not set" thrown from import.

- [ ] **Step 5: Commit**

```bash
cd /Users/ovieoghor/gcp-call-insights-consent
git add src/scripts/record-consent.ts package.json
git commit -m "feat(consent): record-consent main() entrypoint + npm script"
```

---

### Task 4: Point the operator runbook at the new command

**Files:**
- Modify: `docs/demo-sample-validation-railway.md`

- [ ] **Step 1: Read the current consent-recording section**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && sed -n '95,120p' docs/demo-sample-validation-railway.md`
Expected: shows the "Record the five §0.2 consent gates / You are handling this" step with only a verification `SELECT`.

- [ ] **Step 2: Replace the manual-SQL guidance with the command**

Edit the section so that, instead of instructing a raw SQL insert, it shows one `record-consent` invocation per gate, keeping the existing verification `SELECT`. Use this block (adjust surrounding prose minimally to fit the doc's voice — do not remove the verification query):

````markdown
Record each of the five §0.2 processing consent gates with the operator command
(one per gate, each with a one-line evidence note pointing at the signed
document / confirmation):

```bash
npm run record-consent -- --gate dialpad_recording_consent \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate signed_services_agreement \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate signed_data_processing_addendum \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate anthropic_no_training_confirmation \
  --by "<your name>" --note "<where the proof lives>"
npm run record-consent -- --gate anthropic_data_retention_confirmation \
  --by "<your name>" --note "<where the proof lives>"
```

The command refuses an unknown gate name, skips a gate that is already recorded,
and after each run prints which required gates remain — so you know when the gate
is fully cleared. Verify:
````

(Leave the existing `SELECT ... FROM consent_gates` verification query that follows.)

- [ ] **Step 3: Verify formatting**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && npm run format:check 2>&1 | tail -5`
Expected: passes (or reformat with `npm run format` if the doc is not in `.prettierignore`).

- [ ] **Step 4: Commit**

```bash
cd /Users/ovieoghor/gcp-call-insights-consent
git add docs/demo-sample-validation-railway.md
git commit -m "docs: point consent-gate step at record-consent command instead of raw SQL"
```

---

### Task 5: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Lint, typecheck, targeted tests, build, format**

Run each and confirm the expected result:

```bash
cd /Users/ovieoghor/gcp-call-insights-consent
npm run lint                 # Expected: clean
npm run typecheck            # Expected: clean
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test \
  npx vitest run test/scripts/record-consent-args.test.ts test/db/record-consent.test.ts
                             # Expected: 13 passed
npm run build                # Expected: succeeds
npm run format:check         # Expected: clean
```

- [ ] **Step 2: Confirm no unrelated files changed**

Run: `cd /Users/ovieoghor/gcp-call-insights-consent && git status --porcelain`
Expected: empty (all work committed).

- [ ] **Step 3: Note the pre-existing baseline failures**

The 11 shared-test-DB failure files (migration/roundtrip/roles + review-surface DB tests) are pre-existing environment noise unrelated to this change (they were red before any code was written and are green in CI). Do NOT attempt to fix them here. Only the two `record-consent` test files are in scope for a green result.

---

## Self-Review

**Spec coverage:**
- One-gate-per-run CLI with `--gate/--by/--note` → Tasks 1, 3. ✓
- Validate `--gate` against canonical vocabulary → Task 1 (`ALLOWED_GATE_TYPES`, imported from gates.ts). ✓
- `--by` and `--note` required, non-empty → Task 1. ✓
- Idempotent skip + `--force` → Task 2. ✓
- Insert via existing `recordConsent`, no new SQL → Task 2. ✓
- "Still missing" report via `checkProcessingGates` → Task 2 / Task 3 output. ✓
- Main DB pool (DB-A), no staging guard → Task 3 (`createAppPool(config.DATABASE_URL)`; explicit design note against a staging guard). ✓
- Unit (no DB) + integration (test DB) tests → Tasks 1, 2. ✓
- No migration / schema / gate-check change → confirmed across all tasks. ✓
- Runbook consistency (was: hand-write SQL) → Task 4. ✓

**Placeholder scan:** none — every step has concrete code/commands. The `<your name>` / `<where the proof lives>` tokens in Task 4 are intentional operator-fill placeholders in doc content, not plan gaps.

**Type consistency:** `RecordConsentArgs` (Task 1) is consumed unchanged by `runRecordConsent` (Task 2) and `main` (Task 3); `RecordConsentResult` fields (`inserted`, `alreadyRecorded`, `existingRecordedBy`, `existingRecordedAt`, `missingProcessingGates`) are produced in Task 2 and read identically in Task 3. `ALLOWED_GATE_TYPES` / `parseRecordConsentArgs` / `runRecordConsent` names match across tasks and both test files. ✓
