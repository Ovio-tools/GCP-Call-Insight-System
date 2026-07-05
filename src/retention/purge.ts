import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { withClientTransaction } from '../db/sql.js';
import {
  countRawPurgeEligible,
  listRawPurgeEligible,
  markRawPurged,
} from '../db/repositories/review-queue-repo.js';

/**
 * Task 8.1 — scheduled retention purge. Deletion lives ONLY here (never the per-call path).
 *
 * Groups (CLAUDE.md §2 "purged with" pairs are coupled + atomic):
 *   - RAW     : raw_transcripts (+ token_vault)     — parent-driven, review-blocked pre-cap
 *   - CLEAN   : clean_transcripts (+ redaction_findings) — parent-driven, review-blocked; two-mode
 *   - WEBHOOK : raw_webhook_events                   — own window
 *   - MATCH   : match_keys                           — own window
 *   - EXTRACT : extraction_candidates                — own window
 * Plus the held-cap pass (Task 6.1 ↔ 8.1 seam): PHYSICAL delete of raw/vault past the raw-PII cap.
 *
 * Two windowed passes per group: SOFT (recoverable `soft_deleted_at`) then HARD (stamp-and-scrub —
 * `hard_deleted_at` + overwrite content; the tombstone stays so the finality guards keep meaning).
 * Hard is grace-gated: it requires `soft_deleted_at` set and older than the (hard - soft) grace, so
 * a row is soft-deleted on one run and only hard-deleted on a LATER run — never both at once.
 */

export interface PurgeAction {
  table: string;
  group: string;
  action: 'soft_delete' | 'hard_delete' | 'held_cap_purge';
  window: string;
  count: number;
}
export interface GroupCount {
  group: string;
  action: string;
  calls: number;
}
export interface PurgeReport {
  dryRun: boolean;
  skipped?: boolean;
  actions: PurgeAction[];
  groupCounts: GroupCount[];
}
export interface PurgeDeps {
  /** A pool bound to `purge_role`. */
  pool: Pool;
  config: Config;
  logger: Logger;
  now: Date;
}

/** Fixed session-level advisory lock key: only one retention run mutates at a time. */
const LOCK_KEY = 8_100_001;

/** Sanitized metadata a purge failure carries — PII-free, string/scalar only. */
export interface PurgeErrorContext {
  group: string;
  table: string;
  action: string;
  dry_run: boolean;
  sqlstate?: string;
}

/**
 * A purge step failed. Its `message` is SANITIZED — only the group/table/action/dry_run/sqlstate
 * context, never the underlying pg error text (which can carry row data via DETAIL). The raw
 * cause is attached via the standard `cause` option for local debugging only; it is NOT folded
 * into `message` or `stack`, so `String(err)` / an entrypoint stderr dump stays PII-free
 * ("no transcript content or PII in any log line, ever").
 */
export class RetentionPurgeError extends Error {
  readonly context: PurgeErrorContext;
  constructor(context: PurgeErrorContext, cause: unknown) {
    const sqlstate = context.sqlstate ? ` sqlstate=${context.sqlstate}` : '';
    super(
      `retention purge failed at ${context.group}/${context.table} (${context.action}, dry_run=${context.dry_run})${sqlstate}`,
      { cause },
    );
    this.name = 'RetentionPurgeError';
    this.context = context;
  }
}

/** Extract a pg SQLSTATE from an unknown error, or undefined. */
function sqlstateOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Scrub SET fragments per table (hard-delete overwrites content in place; §1a). */
const SCRUB: Record<string, string> = {
  raw_transcripts: `ciphertext = ''::bytea`,
  token_vault: `ciphertext = ''::bytea`,
  clean_transcripts: `redacted_text = '', redaction_reasons = '[]'::jsonb`,
  redaction_findings: `value_hash = NULL, residual_scan_result = '{}'::jsonb`,
  raw_webhook_events: `payload = '{}'::jsonb`,
  match_keys: `phone_hmac = NULL, name_hmac = NULL`,
  extraction_candidates: [
    `problem_statement = NULL`,
    `location_in_home = NULL`,
    `access_or_scheduling_notes = NULL`,
    `prior_attempts = NULL`,
    `acquisition_source = NULL`,
    `pii_scan_counts = NULL`,
    `symptoms = '[]'::jsonb`,
    `customer_language = '[]'::jsonb`,
    `concerns = '[]'::jsonb`,
    `competitor_mentions = '[]'::jsonb`,
  ].join(', '),
};

/** Blocking-review NOT EXISTS fragments (mirror the merged 6.1 predicates). `callExpr` is the
 * SQL expression for the row's call_id (e.g. `t.call_id`). */
function rawBlocking(callExpr: string): string {
  return `AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.call_id = ${callExpr}
            AND rq.status IN ('open','in_review','unresolvable') AND rq.raw_purged_at IS NULL)`;
}
function cleanBlocking(callExpr: string): string {
  return `AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.call_id = ${callExpr}
            AND rq.status IN ('open','in_review','unresolvable'))`;
}

type Blocking = 'raw' | 'clean' | 'none';
function blockingFor(kind: Blocking, callExpr: string): string {
  if (kind === 'raw') return rawBlocking(callExpr);
  if (kind === 'clean') return cleanBlocking(callExpr);
  return '';
}

export async function runPurge(deps: PurgeDeps): Promise<PurgeReport> {
  const { pool, config, logger, now } = deps;
  const dryRun = config.RETENTION_DRY_RUN;
  const batch = config.RETENTION_PURGE_BATCH_SIZE;

  const client = await pool.connect();
  try {
    const locked = (
      await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])
    ).rows[0]?.ok;
    if (!locked) {
      logger.info({ component: 'retention-cron' }, 'another retention run active — skipping');
      return { dryRun, skipped: true, actions: [], groupCounts: [] };
    }

    try {
      const ctx: PurgeContext = { client, now, batch, dryRun, actions: [], groupCounts: [] };

      // Coupled groups (parent-driven, atomic per batch, review-blocked).
      await purgeCoupled(ctx, {
        group: 'RAW',
        parent: 'raw_transcripts',
        child: 'token_vault',
        softDays: config.RETENTION_RAW_SOFT_DELETE_DAYS,
        hardDays: config.RETENTION_RAW_HARD_DELETE_DAYS,
        blocking: 'raw',
      });
      if (config.RETENTION_CLEAN_SOFT_DELETE_DAYS !== 'never') {
        await purgeCoupled(ctx, {
          group: 'CLEAN',
          parent: 'clean_transcripts',
          child: 'redaction_findings',
          softDays: config.RETENTION_CLEAN_SOFT_DELETE_DAYS,
          hardDays: config.RETENTION_CLEAN_HARD_DELETE_DAYS as number,
          blocking: 'clean',
        });
      } else {
        logger.info(
          { component: 'retention-cron' },
          'CLEAN retention is indefinite (never) — skipping',
        );
      }

      // Single-table groups (own window, no review coupling).
      await purgeSingle(ctx, {
        group: 'WEBHOOK',
        table: 'raw_webhook_events',
        keyCol: 'id',
        softDays: config.RETENTION_WEBHOOK_SOFT_DELETE_DAYS,
        hardDays: config.RETENTION_WEBHOOK_HARD_DELETE_DAYS,
      });
      await purgeSingle(ctx, {
        group: 'MATCH',
        table: 'match_keys',
        keyCol: 'id',
        softDays: config.RETENTION_MATCH_KEYS_SOFT_DELETE_DAYS,
        hardDays: config.RETENTION_MATCH_KEYS_HARD_DELETE_DAYS,
      });
      await purgeSingle(ctx, {
        group: 'EXTRACT',
        table: 'extraction_candidates',
        keyCol: 'call_id',
        softDays: config.RETENTION_EXTRACT_SOFT_DELETE_DAYS,
        hardDays: config.RETENTION_EXTRACT_HARD_DELETE_DAYS,
      });

      // Held-cap physical purge (Task 6.1 ↔ 8.1 seam).
      await purgeHeldCap(ctx, config.REVIEW_HELD_RAW_RETENTION_CAP_HOURS);

      logger.info(
        {
          component: 'retention-cron',
          dry_run: dryRun,
          actions: ctx.actions.map((a) => ({
            group: a.group,
            table: a.table,
            action: a.action,
            window: a.window,
            count: a.count,
          })),
        },
        'retention purge complete',
      );
      return { dryRun, actions: ctx.actions, groupCounts: ctx.groupCounts };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

interface PurgeContext {
  client: PoolClient;
  now: Date;
  batch: number;
  dryRun: boolean;
  actions: PurgeAction[];
  groupCounts: GroupCount[];
}

interface CoupledSpec {
  group: string;
  parent: string;
  child: string;
  softDays: number;
  hardDays: number;
  blocking: Blocking;
}
interface SingleSpec {
  group: string;
  table: string;
  keyCol: string;
  softDays: number;
  hardDays: number;
  blocking?: Blocking;
}

/** Run one labeled step, rethrowing any error as a RetentionPurgeError with sanitized context. */
async function step<T>(
  meta: Omit<PurgeErrorContext, 'sqlstate'>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RetentionPurgeError) throw err;
    const sqlstate = sqlstateOf(err);
    throw new RetentionPurgeError({ ...meta, ...(sqlstate ? { sqlstate } : {}) }, err);
  }
}

// --- Coupled groups (RAW, CLEAN) ------------------------------------------------------------

async function purgeCoupled(ctx: PurgeContext, spec: CoupledSpec): Promise<void> {
  const { client, now, batch, dryRun } = ctx;
  const { group, parent, child, softDays, hardDays, blocking } = spec;
  const grace = hardDays - softDays;
  const window = `soft=${softDays}d hard=${hardDays}d`;

  // Predicates (now is $1; ids, where used, are $2::text[]).
  const parentSoftWhere = `p.retention_eligible_at IS NOT NULL
    AND p.retention_eligible_at <= $1::timestamptz - make_interval(days => ${softDays})
    AND p.soft_deleted_at IS NULL ${blockingFor(blocking, 'p.call_id')}`;
  const parentHardWhere = `p.retention_eligible_at <= $1::timestamptz - make_interval(days => ${hardDays})
    AND p.soft_deleted_at IS NOT NULL AND p.soft_deleted_at <= $1::timestamptz - make_interval(days => ${grace})
    AND p.hard_deleted_at IS NULL ${blockingFor(blocking, 'p.call_id')}
    AND NOT EXISTS (SELECT 1 FROM ${child} c WHERE c.call_id = p.call_id
      AND c.hard_deleted_at IS NULL
      AND (c.soft_deleted_at IS NULL OR c.soft_deleted_at > $1::timestamptz - make_interval(days => ${grace})))`;
  const orphanSoftWhere = `c.retention_eligible_at IS NOT NULL
    AND c.retention_eligible_at <= $1::timestamptz - make_interval(days => ${softDays})
    AND c.soft_deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.call_id = c.call_id)
    ${blockingFor(blocking, 'c.call_id')}`;
  const orphanHardWhere = `c.retention_eligible_at <= $1::timestamptz - make_interval(days => ${hardDays})
    AND c.soft_deleted_at IS NOT NULL AND c.soft_deleted_at <= $1::timestamptz - make_interval(days => ${grace})
    AND c.hard_deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE p.call_id = c.call_id)
    ${blockingFor(blocking, 'c.call_id')}`;

  if (dryRun) {
    const parentSoft = await countWhere(client, parent, 'p', parentSoftWhere, now);
    const parentHard = await countWhere(client, parent, 'p', parentHardWhere, now);
    // Child counts must match the REAL run: parent-driven children (rows the parent selection
    // drags along) PLUS orphan children on their own window — a child eligible only through its
    // parent would otherwise be under-reported as 0.
    const childParentSoft = await countWhere(
      client,
      child,
      'cc',
      `cc.soft_deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM ${parent} p WHERE p.call_id = cc.call_id AND (${parentSoftWhere}))`,
      now,
    );
    const childParentHard = await countWhere(
      client,
      child,
      'cc',
      `cc.hard_deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM ${parent} p WHERE p.call_id = cc.call_id AND (${parentHardWhere}))`,
      now,
    );
    const childOrphanSoft = await countWhere(client, child, 'c', orphanSoftWhere, now);
    const childOrphanHard = await countWhere(client, child, 'c', orphanHardWhere, now);
    const childSoftTotal = childParentSoft + childOrphanSoft;
    const childHardTotal = childParentHard + childOrphanHard;
    // Grouped call counts are DISTINCT calls, not child rows: a single orphan call can own several
    // child rows (e.g. many vault tokens), so counting rows would overstate calls. Parent rows are
    // one-per-call, and orphan calls are disjoint from parent-driven ones (orphan predicate is
    // NOT EXISTS parent), so the two add without double-counting. Mirrors the real run below.
    const orphanSoftCalls = await countDistinctCallWhere(client, child, 'c', orphanSoftWhere, now);
    const orphanHardCalls = await countDistinctCallWhere(client, child, 'c', orphanHardWhere, now);
    pushAction(ctx, { table: parent, group, action: 'soft_delete', window, count: parentSoft });
    pushAction(ctx, { table: parent, group, action: 'hard_delete', window, count: parentHard });
    pushAction(ctx, { table: child, group, action: 'soft_delete', window, count: childSoftTotal });
    pushAction(ctx, { table: child, group, action: 'hard_delete', window, count: childHardTotal });
    addGroupCalls(ctx, group, 'soft_delete', parentSoft + orphanSoftCalls);
    addGroupCalls(ctx, group, 'hard_delete', parentHard + orphanHardCalls);
    return;
  }

  let parentSoft = 0;
  let childSoft = 0;
  let softCalls = 0;
  // Parent-driven soft.
  for (;;) {
    const done = await step({ group, table: parent, action: 'soft_delete', dry_run: false }, () =>
      withClientTransaction(client, async (c) => {
        const ids = (
          await c.query<{ call_id: string }>(
            `SELECT p.call_id FROM ${parent} p WHERE ${parentSoftWhere} LIMIT ${batch}`,
            [now],
          )
        ).rows.map((r) => r.call_id);
        if (ids.length === 0) return true;
        const rp = await c.query(
          `UPDATE ${parent} SET soft_deleted_at = $1 WHERE call_id = ANY($2::text[]) AND soft_deleted_at IS NULL`,
          [now, ids],
        );
        const rc = await c.query(
          `UPDATE ${child} SET soft_deleted_at = $1 WHERE call_id = ANY($2::text[]) AND soft_deleted_at IS NULL`,
          [now, ids],
        );
        parentSoft += rp.rowCount ?? 0;
        childSoft += rc.rowCount ?? 0;
        softCalls += ids.length;
        return false;
      }),
    );
    if (done) break;
  }
  // Orphan-child soft. Select the distinct call_ids first so we can add them to the grouped call
  // count (a call can own several child rows); the UPDATE row count feeds the per-table action.
  let orphanSoftCalls = 0;
  for (;;) {
    const done = await step({ group, table: child, action: 'soft_delete', dry_run: false }, () =>
      withClientTransaction(client, async (c) => {
        const ids = (
          await c.query<{ call_id: string }>(
            `SELECT DISTINCT c.call_id FROM ${child} c WHERE ${orphanSoftWhere} LIMIT ${batch}`,
            [now],
          )
        ).rows.map((r) => r.call_id);
        if (ids.length === 0) return true;
        const res = await c.query(
          `UPDATE ${child} SET soft_deleted_at = $1
            WHERE call_id = ANY($2::text[]) AND soft_deleted_at IS NULL`,
          [now, ids],
        );
        childSoft += res.rowCount ?? 0;
        orphanSoftCalls += ids.length;
        return false;
      }),
    );
    if (done) break;
  }

  let parentHard = 0;
  let childHard = 0;
  let hardCalls = 0;
  // Parent-driven, grace-gated hard.
  for (;;) {
    const done = await step({ group, table: parent, action: 'hard_delete', dry_run: false }, () =>
      withClientTransaction(client, async (c) => {
        const ids = (
          await c.query<{ call_id: string }>(
            `SELECT p.call_id FROM ${parent} p WHERE ${parentHardWhere} LIMIT ${batch}`,
            [now],
          )
        ).rows.map((r) => r.call_id);
        if (ids.length === 0) return true;
        const rp = await c.query(
          `UPDATE ${parent} SET hard_deleted_at = $1, ${SCRUB[parent]}
            WHERE call_id = ANY($2::text[]) AND hard_deleted_at IS NULL`,
          [now, ids],
        );
        const rc = await c.query(
          `UPDATE ${child} SET hard_deleted_at = $1, ${SCRUB[child]}
            WHERE call_id = ANY($2::text[]) AND hard_deleted_at IS NULL`,
          [now, ids],
        );
        parentHard += rp.rowCount ?? 0;
        childHard += rc.rowCount ?? 0;
        hardCalls += ids.length;
        return false;
      }),
    );
    if (done) break;
  }
  // Orphan-child hard (same distinct-call accounting as the soft pass).
  let orphanHardCalls = 0;
  for (;;) {
    const done = await step({ group, table: child, action: 'hard_delete', dry_run: false }, () =>
      withClientTransaction(client, async (c) => {
        const ids = (
          await c.query<{ call_id: string }>(
            `SELECT DISTINCT c.call_id FROM ${child} c WHERE ${orphanHardWhere} LIMIT ${batch}`,
            [now],
          )
        ).rows.map((r) => r.call_id);
        if (ids.length === 0) return true;
        const res = await c.query(
          `UPDATE ${child} SET hard_deleted_at = $1, ${SCRUB[child]}
            WHERE call_id = ANY($2::text[]) AND hard_deleted_at IS NULL`,
          [now, ids],
        );
        childHard += res.rowCount ?? 0;
        orphanHardCalls += ids.length;
        return false;
      }),
    );
    if (done) break;
  }

  pushAction(ctx, { table: parent, group, action: 'soft_delete', window, count: parentSoft });
  pushAction(ctx, { table: child, group, action: 'soft_delete', window, count: childSoft });
  pushAction(ctx, { table: parent, group, action: 'hard_delete', window, count: parentHard });
  pushAction(ctx, { table: child, group, action: 'hard_delete', window, count: childHard });
  // Distinct calls = parent-driven calls + orphan calls (disjoint; orphan predicate is NOT EXISTS
  // parent), matching the dry-run computation exactly.
  addGroupCalls(ctx, group, 'soft_delete', softCalls + orphanSoftCalls);
  addGroupCalls(ctx, group, 'hard_delete', hardCalls + orphanHardCalls);
}

// --- Single-table groups (WEBHOOK, MATCH, EXTRACT) ------------------------------------------

async function purgeSingle(ctx: PurgeContext, spec: SingleSpec): Promise<void> {
  const { client, now, batch, dryRun } = ctx;
  const { group, table, keyCol, softDays, hardDays } = spec;
  const blocking: Blocking = spec.blocking ?? 'none';
  const grace = hardDays - softDays;
  const window = `soft=${softDays}d hard=${hardDays}d`;

  const softWhere = `t.retention_eligible_at IS NOT NULL
    AND t.retention_eligible_at <= $1::timestamptz - make_interval(days => ${softDays})
    AND t.soft_deleted_at IS NULL ${blockingFor(blocking, 't.call_id')}`;
  const hardWhere = `t.retention_eligible_at <= $1::timestamptz - make_interval(days => ${hardDays})
    AND t.soft_deleted_at IS NOT NULL AND t.soft_deleted_at <= $1::timestamptz - make_interval(days => ${grace})
    AND t.hard_deleted_at IS NULL ${blockingFor(blocking, 't.call_id')}`;

  if (dryRun) {
    const soft = await countWhere(client, table, 't', softWhere, now);
    const hard = await countWhere(client, table, 't', hardWhere, now);
    pushAction(ctx, { table, group, action: 'soft_delete', window, count: soft });
    pushAction(ctx, { table, group, action: 'hard_delete', window, count: hard });
    addGroupCalls(ctx, group, 'soft_delete', soft);
    addGroupCalls(ctx, group, 'hard_delete', hard);
    return;
  }

  const soft = await batchedUpdate(group, table, 'soft_delete', () =>
    client.query(
      `UPDATE ${table} SET soft_deleted_at = $1
        WHERE ${keyCol} IN (SELECT t.${keyCol} FROM ${table} t WHERE ${softWhere} LIMIT ${batch})`,
      [now],
    ),
  );
  const hard = await batchedUpdate(group, table, 'hard_delete', () =>
    client.query(
      `UPDATE ${table} SET hard_deleted_at = $1, ${SCRUB[table]}
        WHERE ${keyCol} IN (SELECT t.${keyCol} FROM ${table} t WHERE ${hardWhere} LIMIT ${batch})`,
      [now],
    ),
  );
  pushAction(ctx, { table, group, action: 'soft_delete', window, count: soft });
  pushAction(ctx, { table, group, action: 'hard_delete', window, count: hard });
  addGroupCalls(ctx, group, 'soft_delete', soft);
  addGroupCalls(ctx, group, 'hard_delete', hard);
}

// --- Held-cap physical purge ----------------------------------------------------------------

async function purgeHeldCap(ctx: PurgeContext, capHours: number): Promise<void> {
  const { client, now, batch, dryRun } = ctx;
  const group = 'HELD_CAP';
  const window = `cap=${capHours}h`;

  if (dryRun) {
    const count = await step(
      { group, table: 'review_queue', action: 'held_cap_purge', dry_run: true },
      () => countRawPurgeEligible(client, capHours, now),
    );
    pushAction(ctx, { table: 'raw_transcripts', group, action: 'held_cap_purge', window, count });
    pushAction(ctx, { table: 'token_vault', group, action: 'held_cap_purge', window, count });
    addGroupCalls(ctx, group, 'held_cap_purge', count);
    return;
  }

  // Batched: fetch at most `batch` eligible rows, purge each (each stamps raw_purged_at so it
  // leaves the eligible set), then re-fetch until a batch comes back empty. Honors
  // RETENTION_PURGE_BATCH_SIZE so a large held-call backlog cannot be loaded/processed unbounded.
  let purged = 0;
  for (;;) {
    const candidates = await step(
      { group, table: 'review_queue', action: 'held_cap_purge', dry_run: false },
      () => listRawPurgeEligible(client, capHours, now, batch),
    );
    if (candidates.length === 0) break;
    for (const row of candidates) {
      await step(
        { group, table: 'raw_transcripts', action: 'held_cap_purge', dry_run: false },
        () =>
          withClientTransaction(client, async (c) => {
            await c.query(`DELETE FROM token_vault WHERE call_id = $1`, [row.call_id]);
            await c.query(`DELETE FROM raw_transcripts WHERE call_id = $1`, [row.call_id]);
            await markRawPurged(c, row.id, now);
          }),
      );
      purged += 1;
    }
    if (candidates.length < batch) break;
  }
  pushAction(ctx, {
    table: 'raw_transcripts',
    group,
    action: 'held_cap_purge',
    window,
    count: purged,
  });
  pushAction(ctx, { table: 'token_vault', group, action: 'held_cap_purge', window, count: purged });
  addGroupCalls(ctx, group, 'held_cap_purge', purged);
}

// --- helpers --------------------------------------------------------------------------------

async function batchedUpdate(
  group: string,
  table: string,
  action: 'soft_delete' | 'hard_delete',
  runOnce: () => Promise<{ rowCount: number | null }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await step({ group, table, action, dry_run: false }, async () => {
      const res = await runOnce();
      return res.rowCount ?? 0;
    });
    total += n;
    if (n === 0) break;
  }
  return total;
}

async function countWhere(
  client: PoolClient,
  table: string,
  alias: string,
  where: string,
  now: Date,
): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} ${alias} WHERE ${where}`,
    [now],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Like {@link countWhere} but counts DISTINCT call_ids — the grouped call metric, not rows. */
async function countDistinctCallWhere(
  client: PoolClient,
  table: string,
  alias: string,
  where: string,
  now: Date,
): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(DISTINCT ${alias}.call_id)::text AS n FROM ${table} ${alias} WHERE ${where}`,
    [now],
  );
  return Number(res.rows[0]?.n ?? 0);
}

function pushAction(ctx: PurgeContext, action: PurgeAction): void {
  ctx.actions.push(action);
}
function addGroupCalls(ctx: PurgeContext, group: string, action: string, calls: number): void {
  ctx.groupCounts.push({ group, action, calls });
}
