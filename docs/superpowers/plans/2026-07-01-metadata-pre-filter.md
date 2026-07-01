# Metadata Pre-Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first per-call pipeline stage — a deterministic, metadata-only pre-filter that drops obvious junk calls before `fetch-transcript`, recording a specific drop reason and short-circuiting the pipeline so the transcript client is never reached for a dropped call.

**Architecture:** A pure decision function (`evaluateMetadata`) reads only `call_state.source_metadata`; a thin stage handler wraps it; the state-machine runner turns a `drop` outcome into an atomic `skipCall` write (`status='skipped'` + `drop_reason` + a `processing_log` row) and returns before advancing. A new nullable `call_state.drop_reason` column with two CHECK constraints enforces the controlled vocabulary and the `status ⇔ drop_reason` invariant; `upsertCallState` is hardened so an ingest re-seed cannot resurrect a terminal (`skipped`/`completed`) call.

**Tech Stack:** Node.js + TypeScript (strict, ESM), zod, node-pg-migrate, `pg`, BullMQ, vitest.

**Spec:** `docs/superpowers/specs/2026-07-01-metadata-pre-filter-design.md`

**Conventions reminder (CLAUDE.md):** runtime zod validation at boundaries; no PII/transcript content in logs; migrations have up+down; every failure/no-silent-catch; frequent commits; branch `task/3.1-metadata-pre-filter` (already checked out), PR into `main`.

---

## File Structure

**Create:**
- `migrations/1782864000006_call_state_drop_reason.cjs` — adds `drop_reason` column + two CHECK constraints.
- `src/pipeline/metadata-prefilter.ts` — pure `evaluateMetadata` + the `metadataPreFilterHandler` stage handler.
- `src/pipeline/handlers.ts` — `productionStageHandlers` (stubs + the real pre-filter handler). Avoids a `stages.ts ↔ metadata-prefilter.ts` import cycle.
- `test/pipeline/metadata-prefilter.test.ts` — pure-function unit tests (no DB).
- `test/db/call-state-drop.test.ts` — DB-backed: constraints, `skipCall`, re-seed preservation.
- `test/pipeline/metadata-prefilter-shortcircuit.test.ts` — DB-backed: runner short-circuit, pass path, corrupt-terminal guard.

**Modify:**
- `src/db/enums.ts` — add `DROP_REASONS`, `dropReasonSchema`, `DropReason`.
- `src/db/schemas/call-state.ts` — add `drop_reason` to `callStateRowSchema`.
- `src/db/repositories/call-state-repo.ts` — terminal-preserving `upsertCallState`; new `skipCall`.
- `src/pipeline/stages.ts` — `STATUS_SKIPPED`, `SKIP_STAGES`, `StageResult`, `pool` on `StageContext`, `StageHandler` return type.
- `src/pipeline/state-machine.ts` — skipped terminal guard + drop branch.
- `src/worker/worker.ts` — default to `productionStageHandlers`.
- `CLAUDE.md` — §2, §3, current-repo-state note.

**Test command note:** run a single test file with `npx vitest run <path>`. DB-backed suites use `describe.skipIf(!hasTestDb)`, so without `TEST_DATABASE_URL` set they report as skipped (green); run them against a real Postgres by exporting `TEST_DATABASE_URL` first.

---

## Task 1: DropReason vocabulary in `src/db/enums.ts`

**Files:**
- Modify: `src/db/enums.ts`
- Test: `test/db/enum-parity.test.ts` (verify we did NOT break it — `DROP_REASONS` is text+CHECK, not a native pg enum, so it must NOT be added to `PG_ENUMS`).

- [ ] **Step 1: Add the vocabulary.** In `src/db/enums.ts`, after the `HELD_REASON` block (around line 29), add:

```ts
/**
 * Metadata pre-filter drop reasons (Task 3.1). A controlled `call_state.drop_reason`
 * vocabulary — NOT a native pg enum: the column is `text` guarded by a CHECK constraint
 * (migration 1782864000006). This tuple MUST stay in sync with that CHECK list by hand
 * (same duplication convention as the `ENUMS` mirror above). Do NOT add to `PG_ENUMS`.
 */
export const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
] as const;
```

And in the zod-schema block near the bottom (after `heldReasonSchema`), add:

```ts
export const dropReasonSchema = z.enum(DROP_REASONS);
```

And in the type block (after `HeldReason`), add:

```ts
export type DropReason = z.infer<typeof dropReasonSchema>;
```

- [ ] **Step 2: Run the enum-parity test to confirm nothing broke.**

Run: `npx vitest run test/db/enum-parity.test.ts`
Expected: PASS (or SKIP without `TEST_DATABASE_URL`) — `DROP_REASONS` is absent from `PG_ENUMS`, so parity is unaffected.

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/db/enums.ts
git commit -m "feat(3.1): add DropReason controlled vocabulary to db enums"
```

---

## Task 2: Migration — `drop_reason` column + CHECK constraints

**Files:**
- Create: `migrations/1782864000006_call_state_drop_reason.cjs`
- Modify: `src/db/schemas/call-state.ts`
- Test: `test/db/call-state-drop.test.ts` (created here; grows in later tasks)

- [ ] **Step 1: Write the failing test** for the two constraints. Create `test/db/call-state-drop.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';
import { cleanupCalls, makeAppPool } from './_dal.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';

const PATTERN = 'test-drop-%';

describe.skipIf(!hasTestDb)('call_state.drop_reason constraints', () => {
  let owner!: Pool;
  let app!: Pool;

  // Returns the inserted CallStateRow so tests can assert on parsed columns.
  const seedProcessing = (callId: string) =>
    upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('inserts a processing call through the DAL with drop_reason null', async () => {
    // Verifies the updated callStateRowSchema parses the new column and the app role can
    // read it back — a bad schema or missing grant fails here, right after the migration.
    const callId = 'test-drop-dal-insert';
    const row = await seedProcessing(callId);
    expect(row.status).toBe('processing');
    expect(row.drop_reason).toBeNull();
  });

  it('rejects an out-of-vocabulary drop_reason (value CHECK)', async () => {
    const callId = 'test-drop-badvalue';
    await seedProcessing(callId);
    await expect(
      owner.query(
        `UPDATE call_state SET status='skipped', drop_reason='bogus' WHERE call_id=$1`,
        [callId],
      ),
    ).rejects.toThrow(/call_state_drop_reason_value_chk|violates check constraint/i);
  });

  it('rejects status=skipped with a NULL reason (biconditional CHECK)', async () => {
    const callId = 'test-drop-skipnull';
    await seedProcessing(callId);
    await expect(
      owner.query(`UPDATE call_state SET status='skipped' WHERE call_id=$1`, [callId]),
    ).rejects.toThrow(/call_state_status_drop_reason_chk|violates check constraint/i);
  });

  it('rejects a non-skipped status carrying a reason (biconditional CHECK)', async () => {
    const callId = 'test-drop-procreason';
    await seedProcessing(callId);
    await expect(
      owner.query(
        `UPDATE call_state SET drop_reason='zero_duration' WHERE call_id=$1`,
        [callId],
      ),
    ).rejects.toThrow(/call_state_status_drop_reason_chk|violates check constraint/i);
  });

  it('accepts status=skipped with a valid reason', async () => {
    const callId = 'test-drop-ok';
    await seedProcessing(callId);
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration' WHERE call_id=$1`,
      [callId],
    );
    const res = await owner.query<{ status: string; drop_reason: string | null }>(
      `SELECT status, drop_reason FROM call_state WHERE call_id=$1`,
      [callId],
    );
    expect(res.rows[0]).toEqual({ status: 'skipped', drop_reason: 'zero_duration' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts`
Expected: FAIL — the `drop_reason` column does not exist yet (or, without `TEST_DATABASE_URL`, SKIP; in that case proceed and rely on CI/DB run).

- [ ] **Step 3: Write the migration.** Create `migrations/1782864000006_call_state_drop_reason.cjs`:

```js
'use strict';

/**
 * Migration 6 — call_state.drop_reason (Task 3.1, metadata pre-filter).
 *
 * Adds a nullable drop_reason recording WHY a call was skipped by the metadata
 * pre-filter, plus two CHECK constraints:
 *  - value: drop_reason must be NULL or one of the controlled DROP_REASONS. This list
 *    MUST stay in sync with DROP_REASONS in src/db/enums.ts (hand-kept, like the ENUMS
 *    mirror).
 *  - relationship: (status='skipped') = (drop_reason IS NOT NULL) — a skipped row must
 *    carry a reason and only a skipped row may carry one.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

exports.shorthands = undefined;

const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
];

const VALUE_CHK = 'call_state_drop_reason_value_chk';
const REL_CHK = 'call_state_status_drop_reason_chk';

/** @param {MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('call_state', { drop_reason: { type: 'text' } });
  const list = DROP_REASONS.map((r) => `'${r}'`).join(', ');
  pgm.addConstraint('call_state', VALUE_CHK, {
    check: `drop_reason IS NULL OR drop_reason IN (${list})`,
  });

  // Precondition: fail loud if any pre-existing 'skipped' rows exist. Before Task 3.1 the
  // status vocabulary was only 'processing'/'completed', so a 'skipped' row here would
  // carry a NULL drop_reason (the column is brand new) and would make the biconditional
  // constraint below fail to validate. Remediate such rows before migrating.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM call_state WHERE status = 'skipped') THEN
        RAISE EXCEPTION 'pre-existing skipped call_state rows must be remediated before migration 1782864000006';
      END IF;
    END $$;
  `);

  pgm.addConstraint('call_state', REL_CHK, {
    check: `(status = 'skipped') = (drop_reason IS NOT NULL)`,
  });
};

/** @param {MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint('call_state', REL_CHK);
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.dropColumn('call_state', 'drop_reason');
};
```

- [ ] **Step 4: Add `drop_reason` to the row schema.** In `src/db/schemas/call-state.ts`, add the field to `callStateRowSchema` (after `status`):

```ts
export const callStateRowSchema = z.object({
  call_id: z.string(),
  source: z.string(),
  source_metadata: jsonValueSchema,
  current_stage: z.string(),
  status: z.string(),
  drop_reason: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
});
```

(Leave `callStateInsertSchema` unchanged — inserts never set `drop_reason`; only `skipCall` does.)

- [ ] **Step 5: Run the test to verify it passes.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts`
Expected: PASS (or SKIP without a DB). If a stale schema lingers, reset with `npx vitest run test/db/schema-roundtrip.test.ts` after migrating.

- [ ] **Step 6: Test the migration precondition guard.** Create `test/db/migration-drop-reason.test.ts` — its own file so the migration down/up never interleaves with the shared-pool describes in `call-state-drop.test.ts` (`fileParallelism: false` serializes files, and node-pg-migrate wraps each migration in a transaction, so a failed `up` rolls migration 6 back cleanly):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { hasTestDb, makePool, migrate } from './_pg.js';

describe.skipIf(!hasTestDb)('migration 6 precondition (pre-existing skipped rows)', () => {
  let pool!: Pool;

  beforeAll(async () => {
    await migrate('up');
    pool = makePool();
  });
  afterAll(async () => {
    await migrate('up'); // ensure the schema is fully migrated for later suites
    await pool.end();
  });

  it('fails loudly if a skipped call_state row pre-exists', async () => {
    const callId = 'test-drop-preexisting-skipped';
    // Roll migration 6 back so drop_reason and its constraints are gone.
    await migrate('down', 1);
    try {
      // A legacy 'skipped' row with no drop_reason column present.
      await pool.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1, 'test', 'metadata-pre-filter', 'skipped')`,
        [callId],
      );

      await expect(migrate('up', 1)).rejects.toThrow(/pre-existing skipped call_state rows/i);
    } finally {
      // Remediate and restore migration 6 for the rest of the suite.
      await pool.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
      await migrate('up', 1);
    }
  });
});
```

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/migration-drop-reason.test.ts`
Expected: PASS (or SKIP without a DB). The migration raises inside its transaction, which rolls back the partial column/constraint add.

- [ ] **Step 7: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: PASS (the new `drop_reason` field is now part of `CallStateRow`).

- [ ] **Step 8: Commit.**

```bash
git add migrations/1782864000006_call_state_drop_reason.cjs src/db/schemas/call-state.ts \
  test/db/call-state-drop.test.ts test/db/migration-drop-reason.test.ts
git commit -m "feat(3.1): add call_state.drop_reason column + CHECK constraints"
```

---

## Task 3: Terminal-preserving `upsertCallState`

**Files:**
- Modify: `src/db/repositories/call-state-repo.ts:17-33`
- Test: `test/db/call-state-drop.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test.** Append to `test/db/call-state-drop.test.ts`, inside the same file but as a new `describe.skipIf(!hasTestDb)` block (below the constraints block):

```ts
describe.skipIf(!hasTestDb)('upsertCallState preserves terminal rows', () => {
  let owner!: Pool;
  let app!: Pool;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, 'test-reseed-%');
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('does not resurrect a skipped call on re-seed', async () => {
    const callId = 'test-reseed-skip';
    // Seed processing, then mark skipped directly (skipCall lands in Task 4; use SQL here).
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      sourceMetadata: { duration: 0 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration' WHERE call_id=$1`,
      [callId],
    );

    // A reconciliation/webhook re-seed arrives with fresh metadata + processing status.
    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      sourceMetadata: { duration: 999 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

    expect(after.status).toBe('skipped');
    expect(after.drop_reason).toBe('zero_duration');
    expect(after.current_stage).toBe('metadata-pre-filter');
    expect(after.source).toBe('dialpad'); // original source frozen
    expect(after.source_metadata).toEqual({ duration: 0 }); // original metadata frozen
  });

  it('does not resurrect a completed call on re-seed', async () => {
    const callId = 'test-reseed-done';
    await upsertCallState(app, {
      callId,
      source: 'dialpad',
      currentStage: 'mark-retention-eligible',
      status: 'completed',
    });
    const after = await upsertCallState(app, {
      callId,
      source: 'reconciliation',
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    expect(after.status).toBe('completed');
    expect(after.current_stage).toBe('mark-retention-eligible');
  });

  it('still overwrites a non-terminal (processing) row', async () => {
    const callId = 'test-reseed-proc';
    await upsertCallState(app, {
      callId, source: 'test', currentStage: 'fetch-transcript', status: 'processing',
    });
    const after = await upsertCallState(app, {
      callId, source: 'test', currentStage: 'classify', status: 'processing',
    });
    expect(after.current_stage).toBe('classify');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts -t 'preserves terminal'`
Expected: FAIL — current upsert overwrites `status`/`current_stage`/`source` from `EXCLUDED` (or SKIP without a DB).

- [ ] **Step 3: Implement the terminal-preserving upsert.** Replace the `INSERT ... ON CONFLICT ...` SQL in `upsertCallState` (`src/db/repositories/call-state-repo.ts`) with:

```ts
  const rows = await query<CallStateRow>(
    pool,
    `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5)
     ON CONFLICT (call_id) DO UPDATE SET
       source = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source ELSE EXCLUDED.source END,
       source_metadata = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.source_metadata ELSE EXCLUDED.source_metadata END,
       current_stage = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.current_stage ELSE EXCLUDED.current_stage END,
       status = CASE WHEN call_state.status IN ('skipped','completed')
                     THEN call_state.status ELSE EXCLUDED.status END,
       updated_at = now()
     RETURNING *`,
    [v.callId, v.source, toJsonParam(v.sourceMetadata), v.currentStage, v.status],
  );
```

(`drop_reason` is intentionally absent from the `SET` list, so it is never touched by an upsert — only `skipCall` writes it. A future explicit reprocess path resets terminal state through its own function, never here.)

- [ ] **Step 4: Run the terminal-preservation tests + the existing idempotency test.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts test/db/upsert-idempotency.test.ts`
Expected: PASS (or SKIP). The idempotency test only upserts `processing` rows, so it is unaffected.

- [ ] **Step 5: Commit.**

```bash
git add src/db/repositories/call-state-repo.ts test/db/call-state-drop.test.ts
git commit -m "fix(3.1): upsertCallState preserves terminal skipped/completed rows"
```

---

## Task 4: `skipCall` DAL helper

**Files:**
- Modify: `src/db/repositories/call-state-repo.ts` (add `skipCall` + imports)
- Test: `test/db/call-state-drop.test.ts` (add a describe block)

- [ ] **Step 1: Add the new imports to the TOP of `test/db/call-state-drop.test.ts`** (mid-file `import` statements are invalid ESM). Add to the existing top-level import section:

```ts
import { DROP_REASONS } from '../../src/db/enums.js';
import { DAL_STALE_STAGE, DalError } from '../../src/db/index.js';
import { skipCall } from '../../src/db/repositories/call-state-repo.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
```

(`upsertCallState`, `hasTestDb`/`makePool`/`migrate`, and `cleanupCalls`/`makeAppPool` are already imported from Task 2.)

- [ ] **Step 2: Append the failing test block** (no import lines) to the end of `test/db/call-state-drop.test.ts`:

```ts
describe.skipIf(!hasTestDb)('skipCall', () => {
  let owner!: Pool;
  let app!: Pool;

  const seedProcessing = (callId: string): Promise<unknown> =>
    upsertCallState(app, {
      callId, source: 'test', currentStage: 'metadata-pre-filter', status: 'processing',
    });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    await cleanupCalls(owner, 'test-skip-%');
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('marks the row skipped with a reason and logs one skipped row', async () => {
    const callId = 'test-skip-basic';
    await seedProcessing(callId);

    const row = await skipCall(app, {
      callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration',
    });

    expect(row.status).toBe('skipped');
    expect(row.drop_reason).toBe('zero_duration');
    expect(row.current_stage).toBe('metadata-pre-filter'); // no forward movement

    const log = await listByCall(app, callId);
    const skipped = log.filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.stage).toBe('metadata-pre-filter');
    expect(skipped[0]?.detail).toEqual({ drop_reason: 'zero_duration' });
  });

  it('stores every DROP_REASONS value (TS/DB parity)', async () => {
    for (const reason of DROP_REASONS) {
      const callId = `test-skip-parity-${reason}`;
      await seedProcessing(callId);
      const row = await skipCall(app, {
        callId, atStage: 'metadata-pre-filter', dropReason: reason,
      });
      expect(row.drop_reason).toBe(reason);
    }
  });

  it('rejects an out-of-vocabulary reason at the DAL (zod) layer', async () => {
    const callId = 'test-skip-badreason';
    await seedProcessing(callId);
    await expect(
      // @ts-expect-error deliberately invalid reason
      skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'bogus' }),
    ).rejects.toBeInstanceOf(DalError);
  });

  it('is idempotent under a double skip (second raises DAL_STALE_STAGE, one log row)', async () => {
    const callId = 'test-skip-double';
    await seedProcessing(callId);
    await skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' });

    let code: string | undefined;
    try {
      await skipCall(app, { callId, atStage: 'metadata-pre-filter', dropReason: 'zero_duration' });
    } catch (err) {
      code = err instanceof DalError ? err.code : 'other';
    }
    expect(code).toBe(DAL_STALE_STAGE);

    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts -t 'skipCall'`
Expected: FAIL — `skipCall` is not exported yet (or SKIP without a DB).

- [ ] **Step 4: Implement `skipCall`.** In `src/db/repositories/call-state-repo.ts`, add the imports at the top. Add:

```ts
import { type DropReason, dropReasonSchema } from '../enums.js';
```

and change the existing `import type { JsonValue } from '../types.js';` line to also bring in the value schema:

```ts
import { type JsonValue, jsonValueSchema } from '../types.js';
```

Then append this helper at the end of the file:

```ts
export interface SkipCallInput {
  callId: string;
  /** Optimistic guard: only skip a call currently at this stage. */
  atStage: string;
  dropReason: DropReason;
  /** Extra PII-free detail merged into the processing_log row. */
  logDetail?: JsonValue;
}

const skipCallSchema = z.object({
  callId: z.string().min(1),
  atStage: z.string().min(1),
  dropReason: dropReasonSchema,
  // A JSON object of PII-free extra detail. Validated (not cast) so a non-JSON value is
  // rejected here rather than blowing up later in appendLog.
  logDetail: z.record(z.string(), jsonValueSchema).optional(),
});

/**
 * Mark a call `skipped` with a specific `drop_reason` AND append a `processing_log`
 * row in ONE transaction — the metadata pre-filter's drop path. `current_stage` is left
 * where it is (no forward movement); the row is never deleted.
 *
 * The `status='processing'` term in the guard makes the write idempotent under
 * concurrency: once the row is `skipped`, a second runner matches zero rows and gets
 * {@link DAL_STALE_STAGE}, so no duplicate `skipped` log row is written. A drop is not a
 * failure-model failure: no error_code, no failure_snapshot.
 */
export async function skipCall(pool: Pool, input: SkipCallInput): Promise<CallStateRow> {
  const v = parseOrThrow(TABLE, skipCallSchema, input);

  return withTransaction(pool, async (client) => {
    const rows = await query<CallStateRow>(
      client,
      `UPDATE call_state
         SET status = 'skipped', drop_reason = $2, updated_at = now()
       WHERE call_id = $1 AND current_stage = $3 AND status = 'processing'
       RETURNING *`,
      [v.callId, v.dropReason, v.atStage],
    );

    if (rows.length === 0) {
      throw new DalError(
        DAL_STALE_STAGE,
        `${DAL_STALE_STAGE}: call_state ${v.callId} not skippable at stage ${v.atStage}`,
        { table: TABLE, call_id: v.callId },
      );
    }

    // Trusted drop_reason goes LAST so a caller's logDetail can never shadow it — the
    // processing_log audit trail must always match the drop_reason written to call_state.
    const detail: JsonValue = { ...(v.logDetail ?? {}), drop_reason: v.dropReason };

    await appendLog(client, {
      callId: v.callId,
      stage: v.atStage,
      outcome: 'skipped',
      detail,
    });

    return parseOrThrow(TABLE, callStateRowSchema, rows[0]);
  });
}
```

(`DalError`, `DAL_STALE_STAGE`, `parseOrThrow`, `query`, `withTransaction`, `appendLog`, and `callStateRowSchema` are already imported at the top of this file — verify and reuse them.)

- [ ] **Step 5: Run the test to verify it passes.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/db/call-state-drop.test.ts -t 'skipCall'`
Expected: PASS (or SKIP without a DB).

- [ ] **Step 6: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/db/repositories/call-state-repo.ts test/db/call-state-drop.test.ts
git commit -m "feat(3.1): add skipCall DAL helper (atomic skip + processing_log)"
```

---

## Task 5: Pipeline types — `StageResult`, `STATUS_SKIPPED`, `SKIP_STAGES`, `pool` on context

**Files:**
- Modify: `src/pipeline/stages.ts`
- Modify: `src/pipeline/state-machine.ts` (one line — supply the newly-required `pool`)
- Test: none yet (types only; exercised by Tasks 6-8). Verified via `npm run typecheck`.

> **Why the runner edit lives here:** making `pool` a required field of `StageContext`
> immediately breaks the runner's single handler call site, so `npm run typecheck` fails
> until it is fixed. Step 5 fixes it in the same task; the `drop`-handling logic comes in
> Task 8.

- [ ] **Step 1: Update `src/pipeline/stages.ts`.** Change the imports at the top:

```ts
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { JsonValue } from '../db/types.js';
import type { DropReason } from '../db/enums.js';
```

- [ ] **Step 2: Add the skipped status + skip-stage set.** After the `STATUS_COMPLETED` declaration (around line 38), add:

```ts
/**
 * `skipped` — the metadata pre-filter dropped this call before fetch-transcript.
 * Terminal, paired with `current_stage` staying at the dropping stage and a non-null
 * `call_state.drop_reason`. Never advances.
 */
export const STATUS_SKIPPED = 'skipped';

/**
 * Stages permitted to end in a `skipped` drop. Only the metadata pre-filter drops today;
 * the runner's terminal `skipped` guard validates `current_stage` against this set.
 */
export const SKIP_STAGES: ReadonlySet<PipelineStage> = new Set(['metadata-pre-filter']);
```

- [ ] **Step 3: Add `StageResult` and extend `StageContext` / `StageHandler`.** Replace the `StageContext` / `StageHandler` block (lines ~45-55) with:

```ts
/**
 * What a stage handler asks the runner to do next:
 * - `continue` — advance to the next stage (the default; `void`/`undefined` also means this).
 * - `drop` — stop the pipeline before the next stage; the runner calls `skipCall` with
 *   `reason` (a controlled `DropReason`), leaving the call `skipped` and recoverable.
 */
export type StageResult =
  | { action: 'continue' }
  | { action: 'drop'; reason: DropReason; detail?: JsonValue };

/** Context handed to each stage handler. `pool` lets a real stage read/write the DB. */
export interface StageContext {
  callId: string;
  stage: PipelineStage;
  logger: Logger;
  pool: Pool;
}

/**
 * A single stage's work. Returns a {@link StageResult}; returning `void` is treated as
 * `{ action: 'continue' }`, so trivial stub stages need no explicit return.
 */
export type StageHandler = (ctx: StageContext) => Promise<StageResult | void>;

export type StageHandlers = Record<PipelineStage, StageHandler>;
```

- [ ] **Step 4: Keep `defaultStageHandlers` as pure stubs.** The existing `defaultStageHandlers` (the `Object.fromEntries(...)` block) stays as-is — each stub logs and returns `Promise<void>`, which now means "continue". No change needed beyond confirming it still type-checks against the new `StageHandler`.

- [ ] **Step 5: Supply `pool` at the runner's handler call site.** In `src/pipeline/state-machine.ts`, `StageContext` now requires `pool`, so update the single invocation (inside `runPipeline`, around line 115). Change:

```ts
      await handlers[stage]({ callId, stage, logger });
```

to:

```ts
      await handlers[stage]({ callId, stage, logger, pool });
```

(`pool` is already the first parameter of `runPipeline`. The `drop`-result handling replaces this whole block in Task 8; this step only keeps typecheck green.)

- [ ] **Step 6: Typecheck.**

Run: `npm run typecheck`
Expected: PASS. (`test/pipeline/state-machine.test.ts` handlers return `void` → still valid, and ignore the extra `pool` in the context.)

- [ ] **Step 7: Commit.**

```bash
git add src/pipeline/stages.ts src/pipeline/state-machine.ts
git commit -m "feat(3.1): add StageResult drop outcome, STATUS_SKIPPED, pool on StageContext"
```

---

## Task 6: Pure `evaluateMetadata` + unit tests

**Files:**
- Create: `src/pipeline/metadata-prefilter.ts`
- Create: `test/pipeline/metadata-prefilter.test.ts`

- [ ] **Step 1: Write the failing unit tests.** Create `test/pipeline/metadata-prefilter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateMetadata } from '../../src/pipeline/metadata-prefilter.js';

const CALL = 'call-A';

describe('evaluateMetadata', () => {
  it('drops a zero-duration call', () => {
    expect(evaluateMetadata(CALL, { duration: 0 })).toEqual({
      action: 'drop', reason: 'zero_duration',
    });
  });

  it('drops a clear non-conversation call state', () => {
    expect(evaluateMetadata(CALL, { state: 'no_answer', duration: 5 })).toEqual({
      action: 'drop', reason: 'non_conversation_call_state',
    });
  });

  it('does NOT drop voicemail (fails open)', () => {
    expect(evaluateMetadata(CALL, { state: 'voicemail', duration: 5 })).toEqual({
      action: 'pass',
    });
  });

  it('drops an explicit outbound internal-only leg', () => {
    expect(
      evaluateMetadata(CALL, { direction: 'outbound', is_internal: true, duration: 30 }),
    ).toEqual({ action: 'drop', reason: 'outbound_no_customer_conversation' });
  });

  it('drops a flagged internal non-operator transfer leg', () => {
    // This leg (call-A) is flagged internal and the operator leg is a DIFFERENT call.
    expect(
      evaluateMetadata(CALL, {
        is_internal: true,
        operator_call_id: 'call-OP',
        master_call_id: 'call-M',
        duration: 12,
      }),
    ).toEqual({ action: 'drop', reason: 'internal_transfer_non_operator_leg' });
  });

  it('passes the true operator/customer leg of a transfer graph', () => {
    // operator_call_id === this call id → this IS the operator leg.
    expect(
      evaluateMetadata('call-OP', {
        operator_call_id: 'call-OP',
        master_call_id: 'call-M',
        duration: 40,
      }),
    ).toEqual({ action: 'pass' });
  });

  it('passes on id inequality alone without an is_internal marker', () => {
    expect(
      evaluateMetadata(CALL, { operator_call_id: 'call-OP', master_call_id: 'call-M', duration: 12 }),
    ).toEqual({ action: 'pass' });
  });

  it('passes an ambiguous outbound call with no internal marker', () => {
    expect(evaluateMetadata(CALL, { direction: 'outbound', duration: 30 })).toEqual({
      action: 'pass',
    });
  });

  it('passes an incomplete transfer graph (master but no operator id)', () => {
    expect(evaluateMetadata(CALL, { master_call_id: 'call-M', duration: 12 })).toEqual({
      action: 'pass',
    });
  });

  it('passes when duration is absent', () => {
    expect(evaluateMetadata(CALL, { direction: 'inbound' })).toEqual({ action: 'pass' });
  });

  it('passes on unparseable / non-object metadata (fail open)', () => {
    expect(evaluateMetadata(CALL, 'not-an-object')).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, null)).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, [1, 2, 3])).toEqual({ action: 'pass' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `npx vitest run test/pipeline/metadata-prefilter.test.ts`
Expected: FAIL — `evaluateMetadata` does not exist.

- [ ] **Step 3: Implement the pure function.** Create `src/pipeline/metadata-prefilter.ts`:

```ts
import { z } from 'zod';
import type { DropReason } from '../db/enums.js';

/**
 * Metadata pre-filter (Task 3.1) — a deterministic, metadata-only decision. Reads ONLY
 * the fields below off `call_state.source_metadata`. It NEVER reads transcript text,
 * calls a model, or logs PII. Every drop rule keys on an explicit positive marker, so a
 * wrong/unconfirmed field mapping can only under-drop (safe), never mis-drop a real call.
 *
 * Field names are provisional until Task 3.2 confirms the real Dialpad payload; the
 * lenient schema below is the single place to adjust them.
 */
const callMetadataSchema = z
  .object({
    duration: z.number().optional(),
    state: z.string().optional(),
    direction: z.string().optional(),
    operator_call_id: z.string().optional(),
    master_call_id: z.string().optional(),
    is_internal: z.boolean().optional(),
  })
  .passthrough();

/** Call states that unambiguously mean no two-party conversation happened. Lowercased. */
const NON_CONVERSATION_STATES: ReadonlySet<string> = new Set([
  'missed',
  'no_answer',
  'failed',
  'busy',
  'canceled',
  'abandoned',
  'rejected',
]);

export type PrefilterOutcome =
  | { action: 'pass' }
  | { action: 'drop'; reason: DropReason };

const drop = (reason: DropReason): PrefilterOutcome => ({ action: 'drop', reason });

/**
 * Decide whether a call passes the metadata pre-filter. `callId` is passed explicitly so
 * the operator-leg comparison never depends on a metadata field. Fails open: anything
 * unparseable, missing, or unclear → pass. First matching rule wins.
 */
export function evaluateMetadata(callId: string, metadata: unknown): PrefilterOutcome {
  const parsed = callMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { action: 'pass' };
  const m = parsed.data;

  // 1. Zero (or negative) duration — no call happened.
  if (typeof m.duration === 'number' && m.duration <= 0) return drop('zero_duration');

  // 2. A call state that clearly means no two-party conversation (any direction).
  if (typeof m.state === 'string' && NON_CONVERSATION_STATES.has(m.state.toLowerCase())) {
    return drop('non_conversation_call_state');
  }

  // 3 & 4 require an EXPLICIT internal-leg marker. Without it, fail open.
  if (m.is_internal === true) {
    // 3. A flagged internal leg that the graph shows is not the operator/customer leg.
    if (typeof m.operator_call_id === 'string' && m.operator_call_id !== callId) {
      return drop('internal_transfer_non_operator_leg');
    }
    // 4. An explicitly internal outbound leg — operator-side dial-out, no customer.
    if (typeof m.direction === 'string' && m.direction.toLowerCase() === 'outbound') {
      return drop('outbound_no_customer_conversation');
    }
  }

  return { action: 'pass' };
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npx vitest run test/pipeline/metadata-prefilter.test.ts`
Expected: PASS (all cases, no DB needed).

- [ ] **Step 5: Commit.**

```bash
git add src/pipeline/metadata-prefilter.ts test/pipeline/metadata-prefilter.test.ts
git commit -m "feat(3.1): pure evaluateMetadata decision function + unit tests"
```

---

## Task 7: Stage handler + production handler set

**Files:**
- Modify: `src/pipeline/metadata-prefilter.ts` (add the handler)
- Create: `src/pipeline/handlers.ts`

> Worker wiring is intentionally deferred to Task 8, so the worker only starts using the
> real handler once the runner actually acts on a `drop` result.

- [ ] **Step 1: Add the stage handler** to `src/pipeline/metadata-prefilter.ts`. Add these imports at the top:

```ts
import { getCallState } from '../db/repositories/call-state-repo.js';
import type { StageContext, StageResult } from './stages.js';
```

Then append the handler at the end of the file:

```ts
/**
 * The `metadata-pre-filter` stage handler: reads the call's `source_metadata`, evaluates
 * it, and returns `drop` (→ the runner calls `skipCall`) or `continue`. Logs only the
 * stage and the controlled drop reason — never metadata values or PII.
 */
export async function metadataPreFilterHandler(ctx: StageContext): Promise<StageResult> {
  const state = await getCallState(ctx.pool, ctx.callId);
  if (!state) {
    // The runner guarantees the row exists before invoking a handler; a vanished row is
    // a real inconsistency, not something to skip past silently.
    throw new Error(`call_state row for ${ctx.callId} vanished before metadata pre-filter`);
  }

  const outcome = evaluateMetadata(ctx.callId, state.source_metadata);
  if (outcome.action === 'drop') {
    ctx.logger.info({ stage: ctx.stage, drop_reason: outcome.reason }, 'metadata pre-filter: drop');
    return { action: 'drop', reason: outcome.reason };
  }

  ctx.logger.info({ stage: ctx.stage }, 'metadata pre-filter: pass');
  return { action: 'continue' };
}
```

- [ ] **Step 2: Create the production handler set.** Create `src/pipeline/handlers.ts`:

```ts
import { metadataPreFilterHandler } from './metadata-prefilter.js';
import { defaultStageHandlers, type StageHandlers } from './stages.js';

/**
 * The real stage handler set used in production: the pure stub handlers with the live
 * `metadata-pre-filter` handler swapped in. Kept in its own module so `stages.ts` (which
 * `metadata-prefilter.ts` imports for types) never imports back into the handler — no
 * import cycle. As later stages get real handlers (fetch-transcript, redact, …), swap
 * them in here.
 */
export const productionStageHandlers: StageHandlers = {
  ...defaultStageHandlers,
  'metadata-pre-filter': metadataPreFilterHandler,
};
```

- [ ] **Step 3: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: PASS (no import cycle: `handlers.ts → metadata-prefilter.ts → stages.ts`; `stages.ts` imports neither). `productionStageHandlers` is exported but not yet consumed by the worker — that wiring lands in Task 8.

- [ ] **Step 4: Commit.**

```bash
git add src/pipeline/metadata-prefilter.ts src/pipeline/handlers.ts
git commit -m "feat(3.1): metadata pre-filter stage handler + production handler set"
```

---

## Task 8: Runner short-circuit + skipped terminal guard + worker wiring

**Files:**
- Modify: `src/pipeline/state-machine.ts`
- Modify: `src/worker/worker.ts:1-12,65`
- Create: `test/pipeline/metadata-prefilter-shortcircuit.test.ts`

- [ ] **Step 1: Write the failing integration test.** Create `test/pipeline/metadata-prefilter-shortcircuit.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createRootLogger } from '../../src/logging/logger.js';
import { runPipeline } from '../../src/pipeline/state-machine.js';
import { defaultStageHandlers, type StageHandlers } from '../../src/pipeline/stages.js';
import { metadataPreFilterHandler } from '../../src/pipeline/metadata-prefilter.js';
import { getCallState, upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { listByCall } from '../../src/db/repositories/processing-log-repo.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-mpf-%';
const logger = createRootLogger({ level: 'silent', name: 'test-mpf' });

describe.skipIf(!hasTestDb)('metadata pre-filter short-circuit', () => {
  let owner!: Pool;
  let app!: Pool;
  let fetchCalls = 0;

  // Real pre-filter handler + a spy standing in for the (not-yet-built) transcript stage.
  const handlers: StageHandlers = {
    ...defaultStageHandlers,
    'metadata-pre-filter': metadataPreFilterHandler,
    'fetch-transcript': async () => {
      fetchCalls += 1;
    },
  };

  const seed = (callId: string, sourceMetadata: unknown): Promise<unknown> =>
    upsertCallState(app, {
      callId,
      source: 'test',
      sourceMetadata: sourceMetadata as never,
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  afterEach(async () => {
    fetchCalls = 0;
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  it('drops a junk call and never reaches fetch-transcript', async () => {
    const callId = 'test-mpf-drop';
    await seed(callId, { duration: 0 });

    await runPipeline(app, callId, logger, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('skipped');
    expect(state?.drop_reason).toBe('zero_duration');
    expect(state?.current_stage).toBe('metadata-pre-filter'); // never advanced
    expect(fetchCalls).toBe(0); // transcript stage never invoked

    // The row is NOT deleted, and exactly one skipped log row exists.
    expect(state).toBeDefined();
    const skipped = (await listByCall(app, callId)).filter((r) => r.outcome === 'skipped');
    expect(skipped).toHaveLength(1);
  });

  it('passes a real call through to fetch-transcript and beyond', async () => {
    const callId = 'test-mpf-pass';
    await seed(callId, { duration: 120, direction: 'inbound' });

    await runPipeline(app, callId, logger, handlers);

    const state = await getCallState(app, callId);
    expect(state?.status).toBe('completed');
    expect(state?.drop_reason).toBeNull();
    expect(fetchCalls).toBe(1); // transcript stage WAS invoked
  });

  it('is a no-op on re-run of a skipped call (no new log rows)', async () => {
    const callId = 'test-mpf-rerun';
    await seed(callId, { duration: 0 });
    await runPipeline(app, callId, logger, handlers);
    const before = (await listByCall(app, callId)).length;

    await runPipeline(app, callId, logger, handlers);

    expect((await listByCall(app, callId)).length).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  it('throws on a corrupt skipped row (skipped status at a non-skip stage)', async () => {
    const callId = 'test-mpf-corrupt';
    await seed(callId, { duration: 0 });
    // Craft an inconsistent terminal row: skipped + a reason, but current_stage is 'redact'
    // (not a skip-stage). The biconditional CHECK still holds (skipped ⇔ reason), so this
    // row is insertable — the runner must reject it rather than silently no-op.
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='zero_duration', current_stage='redact'
        WHERE call_id=$1`,
      [callId],
    );

    await expect(runPipeline(app, callId, logger, handlers)).rejects.toThrow(/inconsistent/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/pipeline/metadata-prefilter-shortcircuit.test.ts`
Expected: FAIL — the runner does not yet handle a `drop` result or a `skipped` status (or SKIP without a DB).

- [ ] **Step 3: Update the runner.** In `src/pipeline/state-machine.ts`:

(a) Extend the imports. Change the `getCallState` import line to also bring in `skipCall`:

```ts
import { advanceStage, getCallState, skipCall } from '../db/repositories/call-state-repo.js';
```

and add to the `./stages.js` import list: `SKIP_STAGES`, `STATUS_SKIPPED`, and the `StageResult` type:

```ts
import {
  FINAL_STAGE,
  PIPELINE_STAGES,
  SKIP_STAGES,
  STATUS_COMPLETED,
  STATUS_PROCESSING,
  STATUS_SKIPPED,
  defaultStageHandlers,
  type PipelineStage,
  type StageHandlers,
  type StageResult,
} from './stages.js';
```

(b) Add the skipped terminal guard. Immediately after the `STATUS_COMPLETED` guard block (the one ending `... 'inconsistent'\n    );\n  }` around line 103), insert:

```ts
  // Terminal no-op guard for a dropped call — mirrors the completed guard. A valid
  // `skipped` row sits at a skip-stage with a non-null drop_reason; anything else is a
  // real inconsistency, not a completed drop.
  if (state.status === STATUS_SKIPPED) {
    if (SKIP_STAGES.has(state.current_stage as PipelineStage) && state.drop_reason !== null) {
      logger.info(
        { stage: state.current_stage, drop_reason: state.drop_reason },
        'call already skipped — no-op',
      );
      return;
    }
    throw new Error(
      `${callId}: skipped status paired with stage '${state.current_stage}' / drop_reason ` +
        `'${state.drop_reason ?? 'null'}' — inconsistent`,
    );
  }
```

(c) Handle a `drop` result in the loop. Replace the handler-invocation block (as left by Task 5, i.e. already passing `pool`):

```ts
    try {
      await handlers[stage]({ callId, stage, logger, pool });
    } catch (cause) {
      // Wrap so the worker's failed-handler knows exactly which stage failed. Fail-closed:
      // PipelineStageError never carries the raw error message.
      throw new PipelineStageError(stage, callId, cause);
    }
```

with:

```ts
    let result: StageResult | void;
    try {
      result = await handlers[stage]({ callId, stage, logger, pool });
    } catch (cause) {
      // Wrap so the worker's failed-handler knows exactly which stage failed. Fail-closed:
      // PipelineStageError never carries the raw error message.
      throw new PipelineStageError(stage, callId, cause);
    }

    // A stage asked to drop the call: skip it atomically and STOP before the next stage,
    // so a dropped call can never reach fetch-transcript.
    if (result && result.action === 'drop') {
      try {
        await skipCall(pool, {
          callId,
          atStage: stage,
          dropReason: result.reason,
          ...(result.detail !== undefined ? { logDetail: result.detail } : {}),
        });
      } catch (err) {
        if (!isStaleStageError(err)) throw err;
        // A concurrent runner won the race. Re-read: if it landed on a terminal state,
        // this is a legitimate no-op; otherwise it is a real inconsistency.
        const raced = await getCallState(pool, callId);
        if (!raced) throw new Error(`call_state row for ${callId} vanished mid-skip`);
        if (raced.status === STATUS_SKIPPED || raced.status === STATUS_COMPLETED) return;
        throw new Error(
          `${callId}: skip raced but status is '${raced.status}' — inconsistent`,
        );
      }
      return;
    }
```

(The rest of the loop — building `toStage`, the `advanceStage` call, and the stale-resolution — is unchanged.)

- [ ] **Step 4: Wire the worker to the production handlers** (now that the runner acts on `drop`). In `src/worker/worker.ts`, update the import (line ~9) from:

```ts
import { defaultStageHandlers, type StageHandlers } from '../pipeline/stages.js';
```

to:

```ts
import type { StageHandlers } from '../pipeline/stages.js';
import { productionStageHandlers } from '../pipeline/handlers.js';
```

and change the default in `createPipelineWorker` (line ~65) from:

```ts
  const handlers = options.handlers ?? defaultStageHandlers;
```

to:

```ts
  const handlers = options.handlers ?? productionStageHandlers;
```

- [ ] **Step 5: Typecheck + build.**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Prove the worker DEFAULT uses the real pre-filter.** The short-circuit test injects handlers into `runPipeline`, so it would pass even if `worker.ts` still used the stub set. Add a worker smoke test that builds a worker with NO injected handlers (→ `productionStageHandlers`) and drives a real job through Redis. Create `test/worker/metadata-prefilter-default.test.ts`:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueCall } from '../../src/queue/pipeline-queue.js';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { hasTestDb, migrate } from '../db/_pg.js';
import { cleanupCalls } from '../db/_dal.js';
import { hasTestRedis } from '../queue/_redis.js';
import { makeWorkerHarness, waitFor, type WorkerHarness } from '../queue/_harness.js';

const PATTERN = 'test-wk-mpf-%';

describe.skipIf(!hasTestDb || !hasTestRedis)('worker default uses the metadata pre-filter', () => {
  let h!: WorkerHarness;

  beforeAll(async () => {
    await migrate('up');
  });
  beforeEach(() => {
    h = makeWorkerHarness();
  });
  afterEach(async () => {
    await cleanupCalls(h.owner, PATTERN);
    await h.close();
  });

  it('skips a junk call before later stages with NO injected handlers', async () => {
    const callId = 'test-wk-mpf-drop';
    // Seed a drop-worthy call directly (harness.seedCall does not take source_metadata).
    await upsertCallState(h.app, {
      callId,
      source: 'test',
      sourceMetadata: { duration: 0 },
      currentStage: 'metadata-pre-filter',
      status: 'processing',
    });
    await enqueueCall(h.queue, callId, h.config);

    // buildWorker() with NO handlers → the worker's productionStageHandlers default,
    // which must carry the real metadata-pre-filter handler. If worker.ts regressed to the
    // stub set, the call would sail through to 'completed' and this test would fail.
    const worker = h.buildWorker();
    void worker.run();
    try {
      await waitFor(async () => (await h.getState(callId))?.status === 'skipped', {
        label: 'call skipped by worker default pre-filter',
      });
    } finally {
      await worker.close();
    }

    const state = await h.getState(callId);
    expect(state?.status).toBe('skipped');
    expect(state?.drop_reason).toBe('zero_duration');
    expect(state?.current_stage).toBe('metadata-pre-filter');
  });
});
```

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL TEST_REDIS_URL=$TEST_REDIS_URL npx vitest run test/worker/metadata-prefilter-default.test.ts`
Expected: PASS (or SKIP without both a DB and Redis).

- [ ] **Step 7: Run the short-circuit test to verify it passes.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/pipeline/metadata-prefilter-shortcircuit.test.ts`
Expected: PASS (or SKIP without a DB).

- [ ] **Step 8: Run the existing state-machine test to confirm no regression.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run test/pipeline/state-machine.test.ts`
Expected: PASS (or SKIP). Its `void`-returning handlers still mean "continue"; the added `pool` in the context is ignored by them.

- [ ] **Step 9: Commit.**

```bash
git add src/pipeline/state-machine.ts src/worker/worker.ts \
  test/pipeline/metadata-prefilter-shortcircuit.test.ts \
  test/worker/metadata-prefilter-default.test.ts
git commit -m "feat(3.1): short-circuit runner on drop; skipped terminal guard; wire worker"
```

---

## Task 9: Documentation — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the `call_state` row in §2.** In the data-stores table, change the `call_state` Contents cell from `per-call status, current stage, metadata` to:

```
per-call status, current stage, metadata, drop_reason (set when skipped)
```

- [ ] **Step 2: Update the metadata-pre-filter bullet in §3.** Replace the existing `metadata pre-filter` bullet with:

```
- **metadata pre-filter** — runs first, on call metadata only (direction, duration,
  call state, related-call graph). No text, no model, no PII, no transcript fetch.
  Drops obvious junk before a transcript is pulled: a drop sets `status='skipped'` and a
  specific `call_state.drop_reason` (`zero_duration`, `non_conversation_call_state`,
  `outbound_no_customer_conversation`, `internal_transfer_non_operator_leg`), writes a
  `processing_log` row, and stops the pipeline before fetch-transcript. The call and its
  metadata are never deleted. Fails safe: anything missing, unknown, or ambiguous passes.
```

- [ ] **Step 3: Update the current-repo-state note** (in the intro, the sentence beginning "Current repo state:"). Add the metadata pre-filter to the list of what exists:

```
Current repo state: the config loader, logger, data-access layer (Task 1.2), queue +
per-call worker skeleton (Task 2.1), the shared failure model (Task 2.2), the shared
HTTP hardening/auth middleware (Task 2.3), and the metadata pre-filter stage (Task 3.1)
exist; the remaining model steps, surfaces, and crons do not yet.
```

- [ ] **Step 4: Verify prettier is happy with the doc.**

Run: `npm run format:check`
Expected: PASS (CLAUDE.md is not in `.prettierignore`; keep lines within the existing wrap width).

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs(3.1): document metadata pre-filter stage + drop_reason"
```

---

## Task 10: Full verification gate + PR

**Files:** none (verification only).

- [ ] **Step 1: Run the full local gate.**

Run:
```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run format:check
```
Expected: all PASS. (DB-backed suites SKIP without `TEST_DATABASE_URL`; run them against Postgres if available — see Step 2.)

- [ ] **Step 2: Run the DB-backed suites against a real Postgres** (if `TEST_DATABASE_URL` is available in this environment/CI):

Run:
```bash
TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run \
  test/db/call-state-drop.test.ts \
  test/pipeline/metadata-prefilter-shortcircuit.test.ts \
  test/pipeline/state-machine.test.ts \
  test/db/upsert-idempotency.test.ts \
  test/db/schema-roundtrip.test.ts \
  test/db/enum-parity.test.ts
```
Expected: all PASS — including the migration up/down round-trip (`schema-roundtrip`) with the new migration.

- [ ] **Step 3: Security scan.**

Run: `npm audit --audit-level=high`
Expected: no high/critical advisories introduced (no new deps were added in this task).

- [ ] **Step 4: Push and open the PR.**

```bash
git push -u origin task/3.1-metadata-pre-filter
gh pr create --base main --title "Task 3.1: metadata pre-filter" --body "$(cat <<'EOF'
Implements Task 3.1 — a deterministic, metadata-only pre-filter stage that drops
obvious junk before fetch-transcript.

- Pure `evaluateMetadata` (metadata only; no transcript, model, or PII); fails safe.
- `call_state.drop_reason` column + value and `status ⇔ drop_reason` CHECK constraints.
- `skipCall` DAL helper: atomic skip + processing_log row, idempotent under concurrency.
- Runner short-circuit on `drop`; a dropped call cannot reach the transcript stage.
- `upsertCallState` hardened so an ingest re-seed cannot resurrect a terminal call.

Spec: docs/superpowers/specs/2026-07-01-metadata-pre-filter-design.md
Plan: docs/superpowers/plans/2026-07-01-metadata-pre-filter.md

Open question for Eric: voicemail is deliberately NOT hard-dropped (fails open).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR opened into `main`; CI runs lint/typecheck/test/build.

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** pure decision fn (Task 6) ✓; drop reasons + fail-open rules (Task 6) ✓; `drop_reason` migration + both CHECKs (Task 2) ✓; controlled `DropReason` enum + `StageResult` type + DB CHECK (Tasks 1, 2, 5) ✓; `skipCall` atomic + concurrency-idempotent (Task 4) ✓; runner short-circuit + skipped terminal guard w/ validation (Task 8) ✓; worker wiring / choke point (Task 7) ✓; terminal re-seed protection incl. `source` (Task 3) ✓; all spec tests (pure cases, short-circuit spy, parity, invalid-reason both layers, invariant, double-skip, re-seed, corrupt-terminal) mapped ✓; docs (Task 9) ✓.
- **Type consistency:** `DropReason`/`dropReasonSchema` (db/enums) used identically in `skipCall`, `StageResult`, `evaluateMetadata`; `StageContext` gains `pool` in Task 5 and is supplied by the runner in Task 8; `skipCall` signature (`{callId, atStage, dropReason, logDetail?}`) matches its call site in Task 8.
- **Placeholders:** none — every code/edit step shows complete content.
- **Provisional field names** (`is_internal`, `state`, etc.) are intentionally isolated in the lenient schema; noted as the single change-point for Task 3.2.
- **Worker-default coverage** (Task 8) proves `worker.ts` uses the real pre-filter, not just an injected handler; **migration precondition** (Task 2) is covered by a focused down/up test.

