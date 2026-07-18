# Call-leg Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop one Dialpad conversation from being processed as multiple call legs (which produces duplicate Knowledge-base rows), and retire the duplicates already stored.

**Architecture:** Every leg of a conversation, when its transcript is fetched, reports the same top-level canonical `call_id`. At the `fetch-transcript` stage we compare the job's leg id to that canonical id; a non-canonical leg is dropped before any model work runs (after ensuring the canonical call is itself queued). Existing duplicate rows are retired by a nullable `superseded_by_call_id` column that the Knowledge-base read queries filter out, populated by a dry-run-first one-off script.

**Tech Stack:** Node.js + TypeScript (strict), Postgres via `node-pg-migrate` (`.cjs` migrations), BullMQ, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-call-leg-deduplication-design.md`

---

## File Structure

- `src/db/enums.ts` — add `duplicate_call_leg` to `DROP_REASONS` (modify).
- `migrations/1782864100002_drop_reason_duplicate_call_leg.cjs` — extend the drop_reason value CHECK (create).
- `src/pipeline/stages.ts` — add `fetch-transcript` to `SKIP_STAGES` (modify).
- `src/dialpad/client/client.ts` — `TranscriptResult` carries `canonicalCallId`; `fetchTranscript` populates it (modify).
- `src/pipeline/fetch-transcript.ts` — collapse non-canonical legs; new `enqueuePipelineJob` dep (modify).
- `src/pipeline/handlers.ts` — wire `enqueuePipelineJob` into the fetch-transcript handler (modify).
- `migrations/1782864100003_structured_knowledge_superseded.cjs` — add `superseded_by_call_id` (create).
- `src/db/repositories/structured-knowledge-repo.ts` — base WHERE excludes superseded rows; add `setStructuredKnowledgeSuperseded` + `listKnowledgeCallIdsPage` (modify).
- `src/scripts/dedupe-call-legs.ts` — one-off cleanup entrypoint (create).
- `src/scripts/dedupe-call-legs-core.ts` — the pure per-row decision function (create).
- Tests colocated under `test/` mirroring the above.

---

## Task 1: Add the `duplicate_call_leg` drop reason

**Files:**
- Modify: `src/db/enums.ts:58-64`
- Create: `migrations/1782864100002_drop_reason_duplicate_call_leg.cjs`
- Modify: `src/pipeline/stages.ts:57`
- Test: `test/db/migration-drop-reason-duplicate-leg.test.ts` (create)

- [ ] **Step 1: Add the value to the TS tuple**

In `src/db/enums.ts`, extend `DROP_REASONS`:

```typescript
export const DROP_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
  'classified_non_customer',
  'duplicate_call_leg',
] as const;
```

- [ ] **Step 2: Add `fetch-transcript` to the skip-valid stages**

In `src/pipeline/stages.ts`, line 57:

```typescript
export const SKIP_STAGES: ReadonlySet<PipelineStage> = new Set([
  'metadata-pre-filter',
  'fetch-transcript',
  'classify',
]);
```

- [ ] **Step 3: Write the migration**

Create `migrations/1782864100002_drop_reason_duplicate_call_leg.cjs`. It drops and re-adds the value CHECK from migration 6 with the extended list. The full lists are hand-kept (same convention as migration 6).

```javascript
/**
 * Migration — add 'duplicate_call_leg' to the call_state.drop_reason value CHECK.
 *
 * A call leg whose transcript reports a different canonical call_id is dropped at the
 * fetch-transcript stage before any model work runs (call-leg deduplication). The list
 * MUST stay in sync with DROP_REASONS in src/db/enums.ts (hand-kept, like migration 6).
 */
const VALUE_CHK = 'call_state_drop_reason_value_chk';

const OLD_REASONS = [
  'zero_duration',
  'non_conversation_call_state',
  'outbound_no_customer_conversation',
  'internal_transfer_non_operator_leg',
  'classified_non_customer',
];
const NEW_REASONS = [...OLD_REASONS, 'duplicate_call_leg'];

const chk = (reasons) =>
  `drop_reason IS NULL OR drop_reason IN (${reasons.map((r) => `'${r}'`).join(', ')})`;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.addConstraint('call_state', VALUE_CHK, { check: chk(NEW_REASONS) });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  // Fail loud if any row already uses the new value — dropping it would orphan those rows.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM call_state WHERE drop_reason = 'duplicate_call_leg') THEN
        RAISE EXCEPTION 'cannot revert: call_state rows use drop_reason=duplicate_call_leg';
      END IF;
    END $$;
  `);
  pgm.dropConstraint('call_state', VALUE_CHK);
  pgm.addConstraint('call_state', VALUE_CHK, { check: chk(OLD_REASONS) });
};
```

- [ ] **Step 4: Write the migration test**

Create `test/db/migration-drop-reason-duplicate-leg.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.TEST_DATABASE_URL;
const hasTestDb = Boolean(url);

describe.skipIf(!hasTestDb)('drop_reason duplicate_call_leg CHECK', () => {
  let owner: Pool;
  let callId: string;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url });
    callId = `dup-leg-${Date.now()}`;
    await owner.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1, 'test', '{}'::jsonb, 'fetch-transcript', 'processing')`,
      [callId],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
    await owner.end();
  });

  it('accepts drop_reason = duplicate_call_leg on a skipped row', async () => {
    await owner.query(
      `UPDATE call_state SET status='skipped', drop_reason='duplicate_call_leg' WHERE call_id=$1`,
      [callId],
    );
    const { rows } = await owner.query(`SELECT drop_reason FROM call_state WHERE call_id=$1`, [
      callId,
    ]);
    expect(rows[0].drop_reason).toBe('duplicate_call_leg');
  });
});
```

- [ ] **Step 5: Apply the migration and run the tests**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run migrate:up
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/db/migration-drop-reason-duplicate-leg.test.ts test/db/call-state-drop.test.ts
```
Expected: PASS. `call-state-drop.test.ts` loops `DROP_REASONS` for TS/DB parity, so the new value is covered automatically.

- [ ] **Step 6: Run the migration up/down roundtrip**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/db/schema-roundtrip.test.ts
```
Expected: PASS (the migration `down` reverts the CHECK cleanly). If any other `test/db` migration test hardcodes a total migration count, bump it — these migrations are appended after the latest (`1782864100001`), so no existing migration is renumbered.

- [ ] **Step 7: Commit**

```bash
git add src/db/enums.ts src/pipeline/stages.ts migrations/1782864100002_drop_reason_duplicate_call_leg.cjs test/db/migration-drop-reason-duplicate-leg.test.ts
git commit -m "feat(dedup): add duplicate_call_leg drop reason + skip stage"
```

---

## Task 2: Surface the canonical call id from the transcript client

**Files:**
- Modify: `src/dialpad/client/client.ts:14` (type) and `:228-256` (fetchTranscript)
- Test: `test/dialpad/client/client.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add to `test/dialpad/client/client.test.ts` (a `describe` block; mirror the existing fetch mock style in that file):

```typescript
describe('fetchTranscript canonicalCallId', () => {
  const okReady = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

  it('returns the top-level call_id as a string when numeric', async () => {
    const client = makeClient(() =>
      okReady({ call_id: 6643403700510720, transcript: 'hello there' }),
    );
    const r = await client.fetchTranscript('4591131021746176');
    expect(r).toEqual({
      kind: 'ready',
      transcript: JSON.stringify({ call_id: 6643403700510720, transcript: 'hello there' }),
      canonicalCallId: '6643403700510720',
    });
  });

  it('returns canonicalCallId verbatim when it is a string', async () => {
    const client = makeClient(() => okReady({ call_id: '6643403700510720', transcript: 'hi' }));
    const r = await client.fetchTranscript('4591131021746176');
    expect(r.kind === 'ready' && r.canonicalCallId).toBe('6643403700510720');
  });

  it('leaves canonicalCallId undefined when the field is absent', async () => {
    const client = makeClient(() => okReady({ transcript: 'no id here' }));
    const r = await client.fetchTranscript('4591131021746176');
    expect(r.kind === 'ready' && r.canonicalCallId).toBeUndefined();
  });
});
```

If `makeClient` is not already a helper in that file, build the client inline the way the existing tests do (`createDialpadClient({ config, limiter, logger })` with a `fetchImpl` stub). Match the file's established pattern.

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm run test -- test/dialpad/client/client.test.ts -t canonicalCallId
```
Expected: FAIL — `canonicalCallId` is not on the result.

- [ ] **Step 3: Widen the result type**

In `src/dialpad/client/client.ts:14`:

```typescript
export type TranscriptResult =
  | { kind: 'ready'; transcript: string; canonicalCallId?: string }
  | { kind: 'not_ready' };
```

- [ ] **Step 4: Populate it in fetchTranscript**

In the `ready` return of `fetchTranscript` (currently `return { kind: 'ready', transcript: text };`), derive the canonical id from the already-parsed body:

```typescript
      // The transcript's top-level call_id is the CANONICAL (master) id — identical across
      // every leg of one conversation. Used downstream to collapse duplicate legs.
      const rawCanonical = parsed.data.call_id;
      const canonicalCallId = rawCanonical === undefined ? undefined : String(rawCanonical);
      return canonicalCallId === undefined
        ? { kind: 'ready', transcript: text }
        : { kind: 'ready', transcript: text, canonicalCallId };
```

- [ ] **Step 5: Run to verify pass**

Run:
```bash
npm run test -- test/dialpad/client/client.test.ts
```
Expected: PASS (new cases + existing cases).

- [ ] **Step 6: Commit**

```bash
git add src/dialpad/client/client.ts test/dialpad/client/client.test.ts
git commit -m "feat(dedup): surface canonical call_id from transcript client"
```

---

## Task 3: Collapse non-canonical legs in the fetch-transcript stage

**Files:**
- Modify: `src/pipeline/fetch-transcript.ts` (deps + ready branch)
- Modify: `src/pipeline/handlers.ts` (wire `enqueuePipelineJob`)
- Test: `test/pipeline/fetch-transcript.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add to `test/pipeline/fetch-transcript.test.ts`. Follow the file's existing harness for building `createFetchTranscriptHandler` deps and a `StageContext`; these cases assert the three canonical outcomes. Provide a fake `enqueuePipelineJob` spy and a real/seeded `pool` per the file's existing DB setup.

```typescript
describe('canonical-leg collapse', () => {
  it('continues and stores when the transcript call_id equals the leg id', async () => {
    const put = vi.fn();
    const enqueue = vi.fn();
    const handler = makeHandler({
      fetchResult: { kind: 'ready', transcript: 'T', canonicalCallId: 'leg-1' },
      putTranscript: put,
      enqueuePipelineJob: enqueue,
    });
    const res = await handler(ctxFor('leg-1'));
    expect(res).toEqual({ action: 'continue' });
    expect(put).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('continues (fail-open) when the transcript has no canonical call_id', async () => {
    const enqueue = vi.fn();
    const handler = makeHandler({
      fetchResult: { kind: 'ready', transcript: 'T' },
      enqueuePipelineJob: enqueue,
    });
    const res = await handler(ctxFor('leg-1'));
    expect(res).toEqual({ action: 'continue' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('drops the leg and enqueues the canonical when it was newly seeded', async () => {
    const put = vi.fn();
    const enqueue = vi.fn();
    // pool seeded so canonical 'master-1' does NOT already exist → seedIfAbsent returns true
    const handler = makeHandler({
      fetchResult: { kind: 'ready', transcript: 'T', canonicalCallId: 'master-1' },
      putTranscript: put,
      enqueuePipelineJob: enqueue,
    });
    const res = await handler(ctxFor('leg-1'));
    expect(res).toEqual({
      action: 'drop',
      reason: 'duplicate_call_leg',
      detail: { canonical_call_id: 'master-1' },
    });
    expect(put).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('master-1');
  });

  it('drops the leg WITHOUT enqueue when the canonical already exists', async () => {
    const enqueue = vi.fn();
    // pre-insert a call_state row for 'master-1' so seedIfAbsent returns false
    await seedExisting('master-1');
    const handler = makeHandler({
      fetchResult: { kind: 'ready', transcript: 'T', canonicalCallId: 'master-1' },
      enqueuePipelineJob: enqueue,
    });
    const res = await handler(ctxFor('leg-1'));
    expect(res.action).toBe('drop');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/pipeline/fetch-transcript.test.ts -t "canonical-leg collapse"
```
Expected: FAIL — `enqueuePipelineJob` is not a dep; no collapse logic.

- [ ] **Step 3: Add the dep and constant**

In `src/pipeline/fetch-transcript.ts`, add to imports:

```typescript
import { markTranscriptWaitStarted, seedCallStateIfAbsent } from '../db/repositories/call-state-repo.js';
import { PIPELINE_STAGES, STATUS_PROCESSING } from './stages.js';
```

Add a source constant near the top of the file:

```typescript
/** Provenance tag for a canonical call rescued into the pipeline because only a
 *  non-canonical leg of the conversation was listed/enqueued. */
const CANONICAL_LEG_SOURCE = 'canonical-leg-rescue';
```

Extend `FetchTranscriptDeps`:

```typescript
  /** Enqueue a pipeline job for a call id (the canonical-leg safeguard). Injected so the stage
   *  stays testable and free of the concrete BullMQ queue type. */
  enqueuePipelineJob: (callId: string) => Promise<void>;
```

- [ ] **Step 4: Implement the collapse in the ready branch**

Replace the current `if (result.kind === 'ready') { ... }` block (lines ~135-142) with:

```typescript
    if (result.kind === 'ready') {
      const canonical = result.canonicalCallId;
      // A leg whose transcript reports a DIFFERENT canonical id is a duplicate of that
      // conversation. Drop it before any model work runs — but first make sure the canonical
      // call itself will be processed, so we never lose a call. Fail-open: an absent canonical
      // id (Dialpad omitted the field) keeps today's behavior.
      if (canonical !== undefined && canonical !== callId) {
        const created = await seedCallStateIfAbsent(pool, {
          callId: canonical,
          source: CANONICAL_LEG_SOURCE,
          currentStage: PIPELINE_STAGES[0],
          status: STATUS_PROCESSING,
        });
        if (created) await deps.enqueuePipelineJob(canonical);
        logger.info(
          { stage, canonical_call_id: canonical, canonical_enqueued: created },
          'non-canonical call leg — dropping duplicate; canonical ensured',
        );
        return {
          action: 'drop',
          reason: 'duplicate_call_leg',
          detail: { canonical_call_id: canonical },
        };
      }

      await putTranscript(deps.rawPool, deps.keyProvider, {
        callId,
        transcript: result.transcript,
      });
      logger.info({ stage }, 'transcript fetched and stored');
      return { action: 'continue' };
    }
```

- [ ] **Step 5: Wire the dep in the production handler builder**

In `src/pipeline/handlers.ts`, find where `createFetchTranscriptHandler({...})` is called inside `buildProductionStageHandlers`. It has `queue` and `config` in scope (they are already passed to the builder). Add the new dep:

```typescript
      enqueuePipelineJob: (cid: string) => enqueueCall(queue, cid, config),
```

Add the import at the top of `src/pipeline/handlers.ts` if not present:

```typescript
import { enqueueCall } from '../queue/pipeline-queue.js';
```

- [ ] **Step 6: Run to verify pass**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/pipeline/fetch-transcript.test.ts
npm run typecheck
```
Expected: PASS and clean typecheck. (`buildProductionStageHandlers` now satisfies the widened `FetchTranscriptDeps`.)

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/fetch-transcript.ts src/pipeline/handlers.ts test/pipeline/fetch-transcript.test.ts
git commit -m "feat(dedup): drop non-canonical call legs at fetch-transcript"
```

---

## Task 4: Add `superseded_by_call_id` and filter it from the KB read model

**Files:**
- Create: `migrations/1782864100003_structured_knowledge_superseded.cjs`
- Modify: `src/db/repositories/structured-knowledge-repo.ts:135-136` (`buildWhere`)
- Test: `test/db/structured-knowledge-superseded.test.ts` (create)

- [ ] **Step 1: Write the migration**

Create `migrations/1782864100003_structured_knowledge_superseded.cjs`:

```javascript
/**
 * Migration — structured_knowledge.superseded_by_call_id.
 *
 * A duplicate call-leg row is retired (hidden from the Knowledge base) by pointing it at the
 * canonical call it duplicates. Nullable; NULL means "live". The KB read queries filter on
 * `superseded_by_call_id IS NULL`. Reversible: set back to NULL to restore a row.
 */
const COLUMN = 'superseded_by_call_id';

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn('structured_knowledge', {
    [COLUMN]: { type: 'text', references: 'call_state', onDelete: 'RESTRICT' },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn('structured_knowledge', COLUMN);
};
```

- [ ] **Step 2: Write the failing repo test**

Create `test/db/structured-knowledge-superseded.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  countStructuredKnowledge,
  searchStructuredKnowledge,
  setStructuredKnowledgeSuperseded,
} from '../../src/db/repositories/structured-knowledge-repo.js';

const url = process.env.TEST_DATABASE_URL;
const hasTestDb = Boolean(url);

describe.skipIf(!hasTestDb)('structured_knowledge supersede filter', () => {
  let pool: Pool;
  const canonical = `sk-canon-${Date.now()}`;
  const dup = `sk-dup-${Date.now()}`;

  const seed = async (id: string) => {
    await pool.query(
      `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
       VALUES ($1,'test','{}'::jsonb,'store','completed') ON CONFLICT DO NOTHING`,
      [id],
    );
    await pool.query(
      `INSERT INTO structured_knowledge
         (call_id, call_intent, service_category, urgency, sentiment, schema_version, prompt_version, model_id)
       VALUES ($1,'service_request','plumbing','routine','neutral',1,'v1','m1')`,
      [id],
    );
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await seed(canonical);
    await seed(dup);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM structured_knowledge WHERE call_id = ANY($1)`, [[canonical, dup]]);
    await pool.query(`DELETE FROM call_state WHERE call_id = ANY($1)`, [[canonical, dup]]);
    await pool.end();
  });

  it('hides a superseded row from search and count', async () => {
    const before = await countStructuredKnowledge(pool, {});
    await setStructuredKnowledgeSuperseded(pool, { callId: dup, canonicalCallId: canonical });
    const after = await countStructuredKnowledge(pool, {});
    expect(after).toBe(before - 1);
    const rows = await searchStructuredKnowledge(pool, {}, { limit: 1000, offset: 0 });
    expect(rows.find((r) => r.call_id === dup)).toBeUndefined();
    expect(rows.find((r) => r.call_id === canonical)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run migrate:up
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/db/structured-knowledge-superseded.test.ts
```
Expected: FAIL — `setStructuredKnowledgeSuperseded` does not exist and the filter is not applied.

- [ ] **Step 4: Seed the base predicate in `buildWhere`**

In `src/db/repositories/structured-knowledge-repo.ts`, change `buildWhere` (line ~136) so `clauses` starts with the supersede filter:

```typescript
  // Superseded (duplicate-leg) rows are always hidden from the KB read model.
  const clauses: string[] = ['superseded_by_call_id IS NULL'];
  const params: unknown[] = [];
```

(The rest of `buildWhere` is unchanged; the `WHERE` is now always present.)

- [ ] **Step 5: Add the writer**

Append to `src/db/repositories/structured-knowledge-repo.ts`:

```typescript
/** Retire a duplicate call-leg row by pointing it at the canonical call it duplicates.
 * Idempotent: only writes a row that is not already superseded. Returns rows affected. */
export async function setStructuredKnowledgeSuperseded(
  q: Queryable,
  input: { callId: string; canonicalCallId: string },
): Promise<number> {
  const rows = await query<{ call_id: string }>(
    q,
    `UPDATE structured_knowledge
       SET superseded_by_call_id = $2
     WHERE call_id = $1 AND superseded_by_call_id IS NULL
     RETURNING call_id`,
    [input.callId, input.canonicalCallId],
  );
  return rows.length;
}

/** One page of KB call_ids (newest first) that are NOT yet superseded — drives the cleanup
 *  one-off. `beforeCreatedAt` is the keyset cursor (exclusive). */
export async function listKnowledgeCallIdsPage(
  q: Queryable,
  opts: { beforeCreatedAt?: Date; limit: number },
): Promise<{ call_id: string; created_at: Date }[]> {
  const params: unknown[] = [];
  const cursor =
    opts.beforeCreatedAt !== undefined
      ? (params.push(opts.beforeCreatedAt), `AND created_at < $${params.length}`)
      : '';
  params.push(opts.limit);
  return query<{ call_id: string; created_at: Date }>(
    q,
    `SELECT call_id, created_at FROM structured_knowledge
     WHERE superseded_by_call_id IS NULL ${cursor}
     ORDER BY created_at DESC, call_id DESC
     LIMIT $${params.length}`,
    params,
  );
}
```

- [ ] **Step 6: Run to verify pass**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/db/structured-knowledge-superseded.test.ts test/knowledge
```
Expected: PASS. Existing knowledge tests still pass (the added predicate has no params and does not shift `$n` positions).

- [ ] **Step 7: Commit**

```bash
git add migrations/1782864100003_structured_knowledge_superseded.cjs src/db/repositories/structured-knowledge-repo.ts test/db/structured-knowledge-superseded.test.ts
git commit -m "feat(dedup): superseded_by_call_id column + KB read filter"
```

---

## Task 5: One-off cleanup script for existing duplicates

**Files:**
- Create: `src/scripts/dedupe-call-legs-core.ts` (pure decision)
- Create: `src/scripts/dedupe-call-legs.ts` (entrypoint)
- Test: `test/scripts/dedupe-call-legs-core.test.ts` (create)

- [ ] **Step 1: Write the failing test for the pure decision**

Create `test/scripts/dedupe-call-legs-core.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { classifyDedupRow } from '../../src/scripts/dedupe-call-legs-core.js';

describe('classifyDedupRow', () => {
  it('marks a real call (canonical equals leg id)', () => {
    const d = classifyDedupRow('c1', { kind: 'ready', transcript: 'T', canonicalCallId: 'c1' }, true);
    expect(d).toEqual({ action: 'keep' });
  });

  it('marks unresolved when the transcript is gone', () => {
    const d = classifyDedupRow('c1', { kind: 'not_ready' }, false);
    expect(d).toEqual({ action: 'unresolved', why: 'transcript_unavailable' });
  });

  it('marks unresolved when canonical id is absent', () => {
    const d = classifyDedupRow('c1', { kind: 'ready', transcript: 'T' }, false);
    expect(d).toEqual({ action: 'unresolved', why: 'no_canonical_id' });
  });

  it('marks canonical_missing when the canonical row is absent', () => {
    const d = classifyDedupRow('leg', { kind: 'ready', transcript: 'T', canonicalCallId: 'master' }, false);
    expect(d).toEqual({ action: 'canonical_missing', canonicalCallId: 'master' });
  });

  it('marks supersede when leg differs and canonical exists', () => {
    const d = classifyDedupRow('leg', { kind: 'ready', transcript: 'T', canonicalCallId: 'master' }, true);
    expect(d).toEqual({ action: 'supersede', canonicalCallId: 'master' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run:
```bash
npm run test -- test/scripts/dedupe-call-legs-core.test.ts
```
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pure decision**

Create `src/scripts/dedupe-call-legs-core.ts`:

```typescript
import type { TranscriptResult } from '../dialpad/client/index.js';

export type DedupDecision =
  | { action: 'keep' }
  | { action: 'unresolved'; why: 'transcript_unavailable' | 'no_canonical_id' }
  | { action: 'canonical_missing'; canonicalCallId: string }
  | { action: 'supersede'; canonicalCallId: string };

/**
 * Decide what to do with one existing structured_knowledge row, given its transcript fetch and
 * whether the canonical row exists. Pure — no IO, no PII (ids only).
 */
export function classifyDedupRow(
  callId: string,
  fetch: TranscriptResult,
  canonicalRowExists: boolean,
): DedupDecision {
  if (fetch.kind !== 'ready') return { action: 'unresolved', why: 'transcript_unavailable' };
  const canonical = fetch.canonicalCallId;
  if (canonical === undefined) return { action: 'unresolved', why: 'no_canonical_id' };
  if (canonical === callId) return { action: 'keep' };
  if (!canonicalRowExists) return { action: 'canonical_missing', canonicalCallId: canonical };
  return { action: 'supersede', canonicalCallId: canonical };
}
```

- [ ] **Step 4: Run to verify pass**

Run:
```bash
npm run test -- test/scripts/dedupe-call-legs-core.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the entrypoint**

Create `src/scripts/dedupe-call-legs.ts`. Model the client/pool/config bootstrap on `src/scripts/reextract-recategorize.ts` (same repo one-off pattern). `--apply` performs writes; default is dry-run.

```typescript
import { loadConfig } from '../config/index.js';
import { createLogger } from '../logging/index.js';
import { createAppPool } from '../db/pool.js';
import { createDialpadClient } from '../dialpad/client/index.js';
import { RedisDualWindowLimiter } from '../dialpad/client/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import {
  getStructuredKnowledge,
  listKnowledgeCallIdsPage,
  setStructuredKnowledgeSuperseded,
} from '../db/repositories/structured-knowledge-repo.js';
import { classifyDedupRow } from './dedupe-call-legs-core.js';

const PAGE = 200;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createAppPool(config.DATABASE_URL);
  const limiterConnection = createQueueConnectionFromConfig(config);
  const limiter = new RedisDualWindowLimiter(limiterConnection, {
    perSecond: config.DIALPAD_RATE_PER_SECOND,
    perMinute: config.DIALPAD_RATE_PER_MINUTE,
  });
  const client = createDialpadClient({ config, limiter, logger });

  const tally = { scanned: 0, kept: 0, superseded: 0, unresolved: 0, canonicalMissing: 0 };
  let cursor: Date | undefined;

  try {
    for (;;) {
      const page = await listKnowledgeCallIdsPage(pool, {
        limit: PAGE,
        ...(cursor ? { beforeCreatedAt: cursor } : {}),
      });
      if (page.length === 0) break;
      for (const row of page) {
        tally.scanned += 1;
        const fetch = await client.fetchTranscript(row.call_id);
        const canonical = fetch.kind === 'ready' ? fetch.canonicalCallId : undefined;
        const canonicalExists =
          canonical !== undefined && canonical !== row.call_id
            ? (await getStructuredKnowledge(pool, canonical)) !== undefined
            : false;
        const decision = classifyDedupRow(row.call_id, fetch, canonicalExists);
        switch (decision.action) {
          case 'keep':
            tally.kept += 1;
            break;
          case 'unresolved':
            tally.unresolved += 1;
            logger.info({ call_id: row.call_id, why: decision.why }, 'dedup: unresolved');
            break;
          case 'canonical_missing':
            tally.canonicalMissing += 1;
            logger.info(
              { call_id: row.call_id, canonical_call_id: decision.canonicalCallId },
              'dedup: canonical row missing — left untouched',
            );
            break;
          case 'supersede':
            tally.superseded += 1;
            logger.info(
              { call_id: row.call_id, canonical_call_id: decision.canonicalCallId, apply },
              apply ? 'dedup: superseding' : 'dedup: WOULD supersede (dry-run)',
            );
            if (apply) {
              await setStructuredKnowledgeSuperseded(pool, {
                callId: row.call_id,
                canonicalCallId: decision.canonicalCallId,
              });
            }
            break;
        }
      }
      cursor = page[page.length - 1]?.created_at;
    }
    logger.info({ ...tally, apply }, 'dedup: complete');
  } finally {
    await pool.end();
    await limiterConnection.quit();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('dedup-call-legs failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
```

Note: on `--apply`, a `supersede` decision that pages by `created_at DESC` is safe — `listKnowledgeCallIdsPage` filters `superseded_by_call_id IS NULL`, and the keyset cursor is `created_at`, so newly-superseded rows simply drop out of later pages. Re-running is idempotent (`setStructuredKnowledgeSuperseded` only writes NULL rows). Verify the exact import paths/names above against the repo before running (`loadConfig`, `createLogger`, `createAppPool`, `RedisDualWindowLimiter` export site) and adjust to match; the logic is unchanged.

- [ ] **Step 6: Typecheck and lint the script**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: clean. Fix any import-path mismatches surfaced here.

- [ ] **Step 7: Commit**

```bash
git add src/scripts/dedupe-call-legs.ts src/scripts/dedupe-call-legs-core.ts test/scripts/dedupe-call-legs-core.test.ts
git commit -m "feat(dedup): one-off cleanup script for existing duplicate legs"
```

---

## Task 6: Integration test — two legs collapse to one row

**Files:**
- Test: `test/pipeline/call-leg-dedup.integration.test.ts` (create)

- [ ] **Step 1: Write the integration test**

Create `test/pipeline/call-leg-dedup.integration.test.ts`. Use the repo's existing pipeline-run harness (`test/_run-pipeline.ts` shim referenced in prior tasks) with a fake Dialpad client whose `fetchTranscript` returns `canonicalCallId: 'master'` for both `leg-a` and `master`, and a fake model layer. Assert the end state:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// import the shared run-pipeline shim + fakes the other pipeline integration tests use

describe.skipIf(!process.env.TEST_DATABASE_URL)('call-leg dedup end to end', () => {
  it('two legs of one call produce exactly one structured_knowledge row', async () => {
    // Arrange: seed call_state rows for 'leg-a' and 'master' (both from reconciliation),
    // fake fetchTranscript -> { kind: 'ready', transcript, canonicalCallId: 'master' } for both.
    // Act: run the pipeline for 'leg-a' then 'master'.
    // Assert:
    //  - 'leg-a' call_state is status='skipped', drop_reason='duplicate_call_leg'
    //  - no raw transcript stored under 'leg-a'
    //  - exactly one structured_knowledge row, call_id = 'master'
    //  - model invocations recorded only for 'master' (zero for 'leg-a')
    const legA = await getCallStateRow('leg-a');
    expect(legA.status).toBe('skipped');
    expect(legA.drop_reason).toBe('duplicate_call_leg');
    const rows = await allKnowledgeRows();
    expect(rows.map((r) => r.call_id)).toEqual(['master']);
    expect(await modelInvocationCount('leg-a')).toBe(0);
  });
});
```

Fill in `getCallStateRow`, `allKnowledgeRows`, `modelInvocationCount`, and the run harness using the exact helpers the sibling pipeline integration tests already use (grep `test/pipeline` for the existing `runPipeline` shim and fake builders — reuse them; do not invent new ones).

- [ ] **Step 2: Run the integration test**

Run:
```bash
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test -- test/pipeline/call-leg-dedup.integration.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/pipeline/call-leg-dedup.integration.test.ts
git commit -m "test(dedup): end-to-end two-legs-collapse-to-one integration test"
```

---

## Task 7: Full verification and PR

- [ ] **Step 1: Run the full gate**

Run:
```bash
npm run lint && npm run typecheck && \
TEST_DATABASE_URL=postgres://localhost:5432/gcp_call_insights_test npm run test && \
npm run build && npm run format:check && npm audit --audit-level=high
```
Expected: all green. If a migration-count/precondition test fails, bump its expected value (migrations were appended, nothing renumbered).

- [ ] **Step 2: Update `.env.example` if needed**

No new env vars are introduced by this plan. Confirm `.env.example` is unchanged; if a schema field was touched, keep it and the example in sync.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin task/dedupe-call-legs
gh pr create --base main --title "fix(dedup): collapse duplicate Dialpad call legs in the knowledge base" --body "$(cat <<'EOF'
## What
Recent calls were appearing twice in the Knowledge base because Dialpad returns each leg of a conversation as its own call in the reconciliation list, and each leg ran the pipeline to completion under a distinct call_id.

## How
- The transcript response's top-level `call_id` is the canonical (master) id. The fetch-transcript stage now drops a leg whose id differs from that canonical id — before any model work — after ensuring the canonical call is queued (never loses a call).
- Existing duplicates are retired via a new `superseded_by_call_id` column that the Knowledge-base read queries filter out, populated by a dry-run-first one-off (`src/scripts/dedupe-call-legs.ts`).

## Out of scope
- `call_id > 2^53` big-integer precision hardening (latent, filed as follow-up).

Spec: `docs/superpowers/specs/2026-07-14-call-leg-deduplication-design.md`
Plan: `docs/superpowers/plans/2026-07-14-call-leg-deduplication.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Post-merge operational note**

After merge and deploy (worker picks up the new stage logic automatically), run the cleanup once in Railway: first dry-run (`node dist/scripts/dedupe-call-legs.js`), review the tally + logged id pairs, then `--apply`. File the big-integer precision follow-up issue.

---

## Self-Review

- **Spec coverage:** prevention (Tasks 1-3), supersede column + KB filter (Task 4), cleanup script (Task 5), integration proof (Task 6), tests + follow-up note (Task 7). Precision descope carried into Task 7 Step 4. All spec sections mapped.
- **Type consistency:** `canonicalCallId?: string` on the `ready` `TranscriptResult` (Task 2) is consumed identically in Tasks 3 and 5; `setStructuredKnowledgeSuperseded({ callId, canonicalCallId })` and `listKnowledgeCallIdsPage` signatures match between Task 4 (definition) and Task 5 (use); `DedupDecision` shape matches between core (Task 5 Step 3) and its test (Step 1); `duplicate_call_leg` spelled identically across enum, migration, handler, and tests.
- **Placeholder scan:** the integration test (Task 6) intentionally defers to existing sibling harness helpers rather than inventing new ones — the assertions are concrete; the helper wiring is a reuse instruction, not a placeholder.
