import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { assertDependenciesReady } from '../boot/readiness.js';
import { createAppPool } from '../db/index.js';
import { createQueueConnectionFromConfig } from '../queue/connection.js';
import { createDialpadClient, RedisDualWindowLimiter } from '../dialpad/client/index.js';
import {
  getStructuredKnowledge,
  listKnowledgeCallIdsPage,
  setStructuredKnowledgeSuperseded,
} from '../db/repositories/structured-knowledge-repo.js';
import { classifyDedupRow } from './dedupe-call-legs-core.js';

/**
 * One-off cleanup for duplicate call-leg rows already in `structured_knowledge` (Task 5 of the
 * call-leg dedup work). Prior tasks made the pipeline drop non-canonical legs going forward and
 * added a `superseded_by_call_id` column that hides retired rows from the KB. This script retires
 * the duplicates that predate that change: it pages through every non-superseded KB row, fetches
 * each call's transcript from Dialpad to read the CANONICAL (master) id, and — for a leg whose id
 * is not the canonical and whose canonical row still exists — points the leg at the canonical via
 * `setStructuredKnowledgeSuperseded`.
 *
 * Safety:
 *  - Dry-run by DEFAULT; only `--apply` performs writes.
 *  - `setStructuredKnowledgeSuperseded` is idempotent (only writes a not-yet-superseded row), so a
 *    re-run supersedes nothing already superseded.
 *  - A superseded row leaves `listKnowledgeCallIdsPage` results (it filters
 *    `superseded_by_call_id IS NULL`); the composite `(created_at, call_id)` keyset cursor keeps
 *    moving past it, so paging stays correct under in-run writes. Never paginate by OFFSET.
 *  - Logs call ids, canonical ids, and counts ONLY — never transcript content or any PII.
 *
 * Usage: `node dist/scripts/dedupe-call-legs.js [--apply]`.
 */

const PAGE = 200;

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'dedupe-call-legs' });
  await assertDependenciesReady(config, logger);

  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const pool = createAppPool(config.DATABASE_URL);
  // A dedicated Redis connection for the outbound Dialpad rate limiter, as in the worker and
  // reconciliation cron.
  const limiterConnection = createQueueConnectionFromConfig(config);
  const limiter = new RedisDualWindowLimiter(limiterConnection, {
    perSecond: config.DIALPAD_RATE_PER_SECOND,
    perMinute: config.DIALPAD_RATE_PER_MINUTE,
  });
  const client = createDialpadClient({ config, limiter, logger });

  const tally = {
    scanned: 0,
    kept: 0,
    superseded: 0,
    unresolved: 0,
    canonicalMissing: 0,
    errored: 0,
  };
  let cursor: { createdAt: Date; callId: string } | undefined;

  try {
    for (;;) {
      const page = await listKnowledgeCallIdsPage(pool, {
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      });
      if (page.length === 0) break;
      for (const row of page) {
        tally.scanned += 1;
        try {
          const fetched = await client.fetchTranscript(row.call_id);
          const canonical = fetched.kind === 'ready' ? fetched.canonicalCallId : undefined;
          const canonicalExists =
            canonical !== undefined && canonical !== row.call_id
              ? (await getStructuredKnowledge(pool, canonical)) !== undefined
              : false;
          const decision = classifyDedupRow(row.call_id, fetched, canonicalExists);
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
        } catch (err) {
          // One throwing row (a Dialpad hiccup on fetchTranscript, or a DB read error) must not
          // abort the whole scan — log ids + a sanitized message only, tally it, and move on so a
          // re-run doesn't re-hit Dialpad for every already-examined row.
          tally.errored += 1;
          logger.warn(
            { call_id: row.call_id, error: err instanceof Error ? err.message : String(err) },
            'dedup: row failed — skipping',
          );
        }
      }
      const last = page[page.length - 1];
      cursor = last ? { createdAt: last.created_at, callId: last.call_id } : undefined;
    }
    logger.info({ ...tally, apply }, 'dedup: complete');
  } finally {
    await limiterConnection.quit();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error('dedupe-call-legs failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
