import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { JobsOptions } from 'bullmq';
import { createInternalApp, MemoryRateStore } from '../../src/http/index.js';
import { registerReviewRoutes } from '../../src/review/routes.js';
import { DEK_BYTES, LocalKeyProvider } from '../../src/crypto/index.js';
import { createRestrictedRunner } from '../../src/db/restricted/restricted-context.js';
import { putTranscript } from '../../src/db/repositories/raw-transcripts-repo.js';
import { putToken } from '../../src/db/restricted/token-vault-repo.js';
import type { HeldReason } from '../../src/db/enums.js';
import type { PipelineJobData, ReprocessQueue } from '../../src/queue/pipeline-queue.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger, FakeAuthProvider, login, type LoggedIn } from '../http/_helpers.js';
import { makePool, makeRawPool } from '../db/_pg.js';
import { makeAppPool, makeRawAppPool, cleanupRawCalls, seedKeyVersion } from '../db/_dal.js';

export const REVIEW_KEY_PROVIDER = new LocalKeyProvider({
  masterKey: Buffer.alloc(DEK_BYTES, 0x09),
  activeKeyVersion: 1,
});

/** A capturing fake queue — no Redis; the tests assert enqueue calls directly. */
export interface CapturedEnqueue {
  data: PipelineJobData;
  jobId: string;
}
export function makeCapturingQueue(fail = false): {
  queue: ReprocessQueue;
  enqueued: CapturedEnqueue[];
} {
  const enqueued: CapturedEnqueue[] = [];
  return {
    enqueued,
    queue: {
      add(_name: string, data: PipelineJobData, opts: JobsOptions & { jobId: string }) {
        if (fail)
          return Promise.reject(
            Object.assign(new Error('redis down'), { code: 'REDIS_UNAVAILABLE' }),
          );
        enqueued.push({ data, jobId: opts.jobId });
        return Promise.resolve(undefined);
      },
    },
  };
}

export interface SeedHeldOpts {
  reason?: HeldReason;
  stage?: string;
  slaMinutes?: number;
  /** Override review_queue.created_at (for retention-cap tests). */
  createdAt?: Date;
  rawPurgedAt?: Date | null;
  /**
   * Seeds `call_state.source_metadata`, e.g. `{ duration: 222_400 }` for the call-length tests.
   * Deliberately the whole object rather than a `durationMs?: number` shortcut — only this form
   * can seed a hostile/drifted value (`{ duration: 'oops' }`) and prove the reader projects it
   * away. Omitted leaves an existing row's metadata untouched.
   */
  sourceMetadata?: Record<string, unknown>;
}

export interface ReviewHarness {
  app: FastifyInstance;
  provider: FakeAuthProvider;
  owner: Pool;
  appPool: Pool;
  /** Raw-store (DB-B) owner pool — setup/cleanup of raw_transcripts + token_vault. */
  rawOwner: Pool;
  /** Raw-store (DB-B) app pool — passed as the review deps' rawPool. */
  rawPool: Pool;
  runner: ReturnType<typeof createRestrictedRunner>;
  config: ReturnType<typeof makeTestConfig>;
  lines: string[];
  enqueued: CapturedEnqueue[];
  now: { value: Date };
  login(opts?: { elevated?: boolean }): Promise<LoggedIn>;
  seedHeld(callId: string, opts?: SeedHeldOpts): Promise<string>;
  seedCleanTranscript(callId: string, text: string): Promise<void>;
  seedRawTranscript(callId: string, text: string): Promise<void>;
  seedVaultToken(callId: string, token: string, plaintext: string): Promise<void>;
  cleanup(pattern: string): Promise<void>;
  close(): Promise<void>;
}

export async function makeReviewHarness(
  overrides: Partial<Parameters<typeof makeTestConfig>[0]> = {},
  queueFail = false,
): Promise<ReviewHarness> {
  const config = makeTestConfig({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    SESSION_COOKIE_SECURE: false,
    REVIEW_ELEVATED_ROLE: 'review_elevated',
    REVIEW_HELD_RAW_RETENTION_CAP_HOURS: 24,
    ...overrides,
  });
  const provider = new FakeAuthProvider();
  const { logger, lines } = makeCapturingLogger();
  const owner = makePool();
  const appPool = makeAppPool();
  // raw_transcripts + token_vault live in the isolated raw store (DB-B): its app pool is the
  // review deps' rawPool, and the restricted runner (vault reveal) wraps that DB-B pool.
  const rawOwner = makeRawPool();
  const rawPool = makeRawAppPool();
  const runner = createRestrictedRunner(rawPool);
  const { queue, enqueued } = makeCapturingQueue(queueFail);
  const now = { value: new Date('2026-07-03T12:00:00.000Z') };

  await seedKeyVersion(owner);

  const app = await createInternalApp({
    config,
    authProvider: provider,
    rateStore: new MemoryRateStore(),
    logger,
  });
  registerReviewRoutes(app, {
    pool: appPool,
    rawPool,
    config,
    logger,
    keyProvider: REVIEW_KEY_PROVIDER,
    runner,
    queue,
    denyTerms: [],
    now: () => now.value,
  });
  await app.ready();

  return {
    app,
    provider,
    owner,
    appPool,
    rawOwner,
    rawPool,
    runner,
    config,
    lines,
    enqueued,
    now,
    login(opts = {}): Promise<LoggedIn> {
      provider.user = {
        id: 'reviewer-1',
        roles: opts.elevated ? ['review_elevated'] : ['reviewer'],
      };
      return login({ app, provider, logger, lines });
    },
    async seedHeld(callId, opts = {}): Promise<string> {
      const reason = opts.reason ?? 'redaction_failed';
      const stage = opts.stage ?? 'redact';
      // COALESCE on both sides keeps the omitted case behaving exactly as before: a fresh row gets
      // '{}', and a conflicting row keeps whatever metadata it already had.
      await owner.query(
        `INSERT INTO call_state (call_id, source, source_metadata, current_stage, status)
         VALUES ($1, 'test', COALESCE($3::jsonb, '{}'::jsonb), $2, 'held')
         ON CONFLICT (call_id) DO UPDATE SET current_stage = EXCLUDED.current_stage,
           source_metadata = COALESCE($3::jsonb, call_state.source_metadata),
           status = 'held', drop_reason = NULL`,
        [
          callId,
          stage,
          opts.sourceMetadata === undefined ? null : JSON.stringify(opts.sourceMetadata),
        ],
      );
      const rq = await owner.query<{ id: string }>(
        `INSERT INTO review_queue (call_id, held_reason, status, sla_due_at, created_at, raw_purged_at)
         VALUES ($1, $2, 'open', $3, COALESCE($4, now()), $5)
         RETURNING id`,
        [
          callId,
          reason,
          new Date(now.value.getTime() + (opts.slaMinutes ?? 60) * 60_000),
          opts.createdAt ?? null,
          opts.rawPurgedAt ?? null,
        ],
      );
      return rq.rows[0]!.id;
    },
    async seedCleanTranscript(callId, text): Promise<void> {
      await owner.query(
        `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons)
         VALUES ($1, $2, 0.1, '[]'::jsonb)
         ON CONFLICT (call_id) DO UPDATE SET redacted_text = EXCLUDED.redacted_text, soft_deleted_at = NULL`,
        [callId, text],
      );
    },
    async seedRawTranscript(callId, text): Promise<void> {
      await putTranscript(rawPool, REVIEW_KEY_PROVIDER, { callId, transcript: text });
    },
    async seedVaultToken(callId, token, plaintext): Promise<void> {
      await putToken(runner, REVIEW_KEY_PROVIDER, {
        callId,
        token,
        plaintext: Buffer.from(plaintext, 'utf8'),
      });
    },
    async cleanup(pattern): Promise<void> {
      await owner.query(`DELETE FROM reprocess_requests WHERE call_id LIKE $1`, [pattern]);
      await owner.query(
        `DELETE FROM operator_actions WHERE review_queue_id IN (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
        [pattern],
      );
      await owner.query(
        `DELETE FROM alert_events WHERE dedup_key IN
           (SELECT 'REVIEW_QUEUE_STALLED:review_queue:' || id FROM review_queue WHERE call_id LIKE $1)`,
        [pattern],
      );
      await owner.query(`DELETE FROM review_queue WHERE call_id LIKE $1`, [pattern]);
      // raw_transcripts + token_vault now live only in the raw store (DB-B).
      await cleanupRawCalls(rawOwner, pattern);
      await owner.query(`DELETE FROM clean_transcripts WHERE call_id LIKE $1`, [pattern]);
      await owner.query(`DELETE FROM extraction_candidates WHERE call_id LIKE $1`, [pattern]);
      await owner.query(`DELETE FROM structured_knowledge WHERE call_id LIKE $1`, [pattern]);
      await owner.query(`DELETE FROM processing_log WHERE call_id LIKE $1`, [pattern]);
      await owner.query(`DELETE FROM call_state WHERE call_id LIKE $1`, [pattern]);
    },
    async close(): Promise<void> {
      await app.close();
      await owner.end();
      await appPool.end();
      await rawOwner.end();
      await rawPool.end();
    },
  };
}

/** POST a review action with the CSRF header. */
export async function postAction(
  harness: ReviewHarness,
  session: LoggedIn,
  reviewId: string,
  action: string,
  body: unknown = {},
): Promise<{ status: number; json: () => unknown; body: string }> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/review/${reviewId}/actions/${action}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: () => res.json(), body: res.body };
}

/** POST a reveal-raw with the CSRF header. */
export async function postReveal(
  harness: ReviewHarness,
  session: LoggedIn,
  reviewId: string,
  token?: string,
): Promise<{ status: number; json: () => unknown }> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/review/${reviewId}/reveal-raw${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    payload: '{}',
  });
  return { status: res.statusCode, json: () => res.json() };
}
