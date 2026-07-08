import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import { enqueueReview } from '../../src/db/repositories/review-queue-repo.js';
import { recordHeartbeat } from '../../src/db/repositories/component-heartbeats-repo.js';
import { recordAlert } from '../../src/db/repositories/alert-events-repo.js';
import { registerStatusRoutes } from '../../src/status/routes.js';
import { hasRawTestDb, hasTestDb, makePool, migrate, migrateRaw } from '../db/_pg.js';
import { makeAppPool, cleanupCalls } from '../db/_dal.js';
import { makeInternalApp, login, type InternalHarness } from '../http/_helpers.js';
import {
  makeReviewHarness,
  postAction,
  postReveal,
  type ReviewHarness,
} from '../review/_harness.js';
import { makeKnowledgeHarness, seedKnowledge } from '../knowledge/_harness.js';
import { makeTestConfig } from '../_config.js';
import {
  ALL_PII_SEEDS,
  assertNoPii,
  assertNoPrototypePollution,
  expectMiddlewareError,
  PII_SEEDS,
  runReadPathMatrix,
  runStatePathHardening,
} from './_security-suite.js';

/**
 * The REAL internal-surface `liveSuite` (Task 9.1): status (7.3), review (6.2), and knowledge-base
 * (10.1) — all three `createInternalApp` surfaces — driven through the cross-cutting matrix against
 * their ACTUAL routes + DB side effects. Reuses the surfaces' own harnesses (never rebuilt).
 *
 * The `shared internal factory contract` block is DB-less and ALWAYS runs: it proves the body/CSRF/
 * error hardening every `createInternalApp` surface inherits (the read-only surfaces have no
 * body-accepting route of their own, so the factory-level guarantee is proven here once + on the
 * review surface's real POST routes).
 */

const silentLogger = { warn: () => undefined, info: () => undefined } as unknown as Logger;

/** A fresh, tiny-IP-limit `createInternalApp` with a single protected probe route — proves the
 * tier-1 limiter the surfaces inherit, without touching the DB or the surface under test. */
async function makeRateLimitProbeApp(): Promise<FastifyInstance> {
  const h = await makeInternalApp({ RATE_LIMIT_MAX: 3 }, undefined, (app) => {
    app.get('/probe', () => ({ ok: true }));
  });
  return h.app;
}

/* =================================================================================================
 * Shared internal factory contract — DB-less, always runs.
 * ============================================================================================== */

describe('shared internal factory contract (createInternalApp)', () => {
  let harness: InternalHarness;

  beforeAll(async () => {
    harness = await makeInternalApp({}, undefined, (app) => {
      // A scratch write route (body-accepting) + a route that throws with planted PII.
      app.post('/scratch/write', (_req, reply) => reply.send({ ok: true }));
      app.get('/scratch/throw', () => {
        throw new Error(`boom ${PII_SEEDS.customerLanguage} ${PII_SEEDS.email}`);
      });
    });
  });
  afterAll(() => harness.app.close());

  it('requires a CSRF token on a state-changing route (403 CSRF_TOKEN_INVALID)', async () => {
    const session = await login(harness);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/scratch/write',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expectMiddlewareError(res, 'CSRF_TOKEN_INVALID');
  });

  it('rejects an oversized body (413), malformed JSON (400), and bad content-type (415)', async () => {
    const big = await harness.app.inject({
      method: 'POST',
      url: '/scratch/write',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(1_200_000),
    });
    expectMiddlewareError(big, 'REQUEST_BODY_TOO_LARGE');

    const malformed = await harness.app.inject({
      method: 'POST',
      url: '/scratch/write',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expectMiddlewareError(malformed, 'REQUEST_MALFORMED');

    const badType = await harness.app.inject({
      method: 'POST',
      url: '/scratch/write',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expectMiddlewareError(badType, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('maps an unexpected thrown error to a PII-free 500 INTERNAL_ERROR (body + logs)', async () => {
    const session = await login(harness);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/scratch/throw',
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'request_id']);
    assertNoPii(res.payload, 'INTERNAL_ERROR body');
    assertNoPii(harness.lines.join('\n'), 'INTERNAL_ERROR logs');
  });

  it('trips the tier-1 IP rate limit (429)', async () => {
    const app = await makeRateLimitProbeApp();
    let res = await app.inject({ method: 'GET', url: '/probe' });
    for (let i = 0; i < 3; i += 1) res = await app.inject({ method: 'GET', url: '/probe' });
    expectMiddlewareError(res, 'RATE_LIMIT_EXCEEDED');
    await app.close();
  });
});

/* =================================================================================================
 * Status surface (7.3) — read-only.
 * ============================================================================================== */

describe.skipIf(!hasTestDb)('status surface (7.3) — security matrix', () => {
  let owner: Pool;
  let app: Pool;

  const STATUS_CONFIG = {
    CLASSIFY_ENABLED: true,
    EXTRACT_ENABLED: true,
    STATUS_PAGE_REFRESH_SECONDS: 30,
  } as const;

  async function makeHarness(): Promise<InternalHarness> {
    return makeInternalApp(STATUS_CONFIG, undefined, (fastifyApp) => {
      registerStatusRoutes(fastifyApp, {
        pool: app,
        config: makeTestConfig(STATUS_CONFIG),
        logger: silentLogger,
        now: () => new Date('2026-07-01T12:00:00.000Z'),
      });
    });
  }

  let harness: InternalHarness;

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await cleanupCalls(owner, 'test-sec-status-%');
    await owner.query('DELETE FROM alert_events');
    await owner.query('DELETE FROM component_heartbeats');
    harness = await makeHarness();
  });
  afterEach(() => harness.app.close());
  afterAll(async () => {
    await cleanupCalls(owner, 'test-sec-status-%');
    await owner.query('DELETE FROM alert_events');
    await owner.end();
    await app.end();
  });

  runReadPathMatrix({
    getApp: () => harness.app,
    login: () => login(harness),
    readPaths: [
      { path: '/status', kind: 'html' },
      { path: '/status.json', kind: 'json' },
    ],
    rateLimit: { makeApp: makeRateLimitProbeApp, path: '/probe', max: 3 },
  });

  it('exposes only sanitized health/counts — never PII from adjacent tables (finding #8)', async () => {
    // A held call whose assignee + clean-transcript body + alert snapshot all carry PII seeds.
    await upsertCallState(app, {
      callId: 'test-sec-status-pii',
      source: 'test',
      currentStage: 'redact',
      status: 'held',
    });
    await enqueueReview(app, {
      callId: 'test-sec-status-pii',
      heldReason: 'missing_transcript',
      slaDueAt: new Date('2026-07-01T13:00:00.000Z'),
      assignee: PII_SEEDS.name,
    });
    await owner.query(
      `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score)
       VALUES ('test-sec-status-pii', $1, 0.1)`,
      [PII_SEEDS.customerLanguage],
    );
    await recordHeartbeat(app, { component: 'worker' });
    // An active alert whose failure_snapshot embeds PII in context + free-text fields.
    await recordAlert(owner, {
      errorCode: 'DIALPAD_RATE_LIMITED',
      rootCauseCategory: 'DIALPAD_RATE_LIMITED',
      severity: 'high',
      dedupKey: 'test-sec-status-alert',
      failureSnapshot: {
        context: { stage: 'redact', call_id: PII_SEEDS.phone, note: PII_SEEDS.address },
        impact: PII_SEEDS.customerLanguage,
        remediation_now: PII_SEEDS.email,
      },
    });

    const { cookie } = await login(harness);
    const html = await harness.app.inject({ method: 'GET', url: '/status', headers: { cookie } });
    const json = await harness.app.inject({
      method: 'GET',
      url: '/status.json',
      headers: { cookie },
    });
    expect(html.statusCode).toBe(200);
    expect(json.statusCode).toBe(200);
    assertNoPii(html.payload, '/status html');
    assertNoPii(json.payload, '/status.json');
    // Sanity: the held reason IS surfaced (only the PII is withheld, not the whole signal).
    expect(json.payload).toContain('missing_transcript');
  });
});

/* =================================================================================================
 * Review surface (6.2).
 * ============================================================================================== */

describe.skipIf(!hasTestDb || !hasRawTestDb)('review surface (6.2) — security matrix', () => {
  let h: ReviewHarness;
  const PATTERN = 'test-sec-review-%';

  beforeAll(async () => {
    await migrate('up');
    await migrateRaw('up');
    h = await makeReviewHarness();
  });
  beforeEach(() => h.cleanup(PATTERN));
  afterAll(() => h.close());

  const operatorActionCount = async (): Promise<number> => {
    const r = await h.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM operator_actions
        WHERE review_queue_id IN (SELECT id FROM review_queue WHERE call_id LIKE $1)`,
      [PATTERN],
    );
    return Number(r.rows[0]!.n);
  };

  // A concrete held review so the detail routes resolve to a real id for the read matrix.
  let detailId = '';
  beforeEach(async () => {
    detailId = await h.seedHeld('test-sec-review-detail', { reason: 'redaction_failed' });
    await h.seedCleanTranscript(
      'test-sec-review-detail',
      'redacted only: [NAME_1] called about a leak',
    );
  });

  runReadPathMatrix({
    getApp: () => h.app,
    login: () => h.login(),
    readPaths: [
      { path: '/review.json', kind: 'json' },
      { path: '/review', kind: 'html' },
      // `detailId` is only known after beforeEach; resolve it lazily at run time (a real UUID, so
      // the detail query does not fail on an invalid-uuid input).
      { path: () => `/review/${detailId}.json`, kind: 'json' },
      { path: () => `/review/${detailId}`, kind: 'html' },
    ],
    rateLimit: { makeApp: makeRateLimitProbeApp, path: '/probe', max: 3 },
  });

  runStatePathHardening({
    label: 'POST /review/:id/actions/:action',
    getApp: () => h.app,
    path: '/review/test-sec-review-nobody/actions/reject',
    session: () => h.login(),
    rejectCode: 'REQUEST_MALFORMED',
    assertNoSideEffect: async () => {
      expect(h.enqueued.length).toBe(0);
      expect(await operatorActionCount()).toBe(0);
    },
  });

  // The second state-changing route. The shared factory enforces CSRF/oversized/malformed/media-type
  // on it too (preHandler + parser run BEFORE the reveal handler) — none reach `performReveal`, so no
  // raw/vault reveal and no audit row. The malicious-body-reject case is skipped: reveal-raw's only
  // input is the `?token=` query param and it does not read its request body (see the reveal-raw
  // body-strictness follow-up in docs/security-audit.md).
  runStatePathHardening({
    label: 'POST /review/:id/reveal-raw',
    getApp: () => h.app,
    path: '/review/test-sec-review-nobody/reveal-raw',
    session: () => h.login({ elevated: true }),
    rejectCode: 'REQUEST_MALFORMED',
    includeMaliciousBody: false,
    assertNoSideEffect: async () => {
      expect(await operatorActionCount()).toBe(0);
    },
  });

  it('detail view never preloads raw/vault (no raw text in the response)', async () => {
    const callId = 'test-sec-review-noraw';
    const id = await h.seedHeld(callId, { reason: 'redaction_failed' });
    await h.seedCleanTranscript(callId, 'redacted body only');
    await h.seedRawTranscript(callId, `Hi this is ${PII_SEEDS.name} at ${PII_SEEDS.phone}`);
    const session = await h.login();
    const res = await h.app.inject({
      method: 'GET',
      url: `/review/${id}`,
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    assertNoPii(res.payload, 'review detail');
  });

  it('reveal-raw: a standard reviewer is refused (403 AUTH_FORBIDDEN), no audit row', async () => {
    const callId = 'test-sec-review-reveal-forbidden';
    const id = await h.seedHeld(callId, { reason: 'redaction_failed' });
    await h.seedRawTranscript(callId, `raw ${PII_SEEDS.name}`);
    const session = await h.login({ elevated: false });
    const res = await postReveal(h, session, id);
    expect(res.status).toBe(403);
    expect((res.json() as { error: string }).error).toBe('AUTH_FORBIDDEN');
    expect(await operatorActionCount()).toBe(0);
  });

  it('reveal-raw: an elevated reveal is call-scoped, writes exactly one sanitized audit row', async () => {
    const callId = 'test-sec-review-reveal-ok';
    const raw = `Hi this is ${PII_SEEDS.name} at ${PII_SEEDS.phone}`;
    const id = await h.seedHeld(callId, { reason: 'redaction_failed' });
    await h.seedRawTranscript(callId, raw);
    const session = await h.login({ elevated: true });
    const res = await postReveal(h, session, id);
    expect(res.status).toBe(200);
    expect((res.json() as { transcript: string }).transcript).toBe(raw);
    // Exactly one reveal_raw audit row; its `after` records only field names + call_id, no plaintext.
    const rows = await h.owner.query<{ action: string; after: Record<string, unknown> }>(
      `SELECT action, after FROM operator_actions WHERE review_queue_id = $1`,
      [id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.action).toBe('reveal_raw');
    assertNoPii(JSON.stringify(rows.rows[0]!.after), 'reveal audit row');
  });

  it('reveal-raw: a token from a different call is rejected (409), no audit row', async () => {
    const callId = 'test-sec-review-reveal-scope';
    const otherCall = 'test-sec-review-reveal-other';
    const id = await h.seedHeld(callId, { reason: 'redaction_failed' });
    await h.seedRawTranscript(callId, 'raw body');
    await h.owner.query(
      `INSERT INTO call_state (call_id, source, current_stage, status) VALUES ($1,'test','redact','held') ON CONFLICT DO NOTHING`,
      [otherCall],
    );
    await h.seedVaultToken(otherCall, '[NAME_9]', PII_SEEDS.name);
    const session = await h.login({ elevated: true });
    const res = await postReveal(h, session, id, '[NAME_9]');
    expect(res.status).toBe(409);
    expect(await operatorActionCount()).toBe(0);
  });

  it('reprocess carries an idempotency key — a repeat submit does not double-enqueue', async () => {
    const callId = 'test-sec-review-reprocess';
    const id = await h.seedHeld(callId, { reason: 'redaction_failed' });
    await h.seedRawTranscript(callId, 'raw body for reprocess');
    const session = await h.login();

    const first = await postAction(h, session, id, 'reprocess', { stage: 'redact' });
    expect(first.status).toBe(200);
    expect(h.enqueued.length).toBe(1);

    // The review is now resolved; the identical action is audit-trail idempotency (noop), never a
    // second enqueue or a duplicate audit row.
    const second = await postAction(h, session, id, 'reprocess', { stage: 'redact' });
    expect(second.status).toBe(200);
    expect((second.json() as { status: string }).status).toBe('noop');
    expect(h.enqueued.length).toBe(1);
    const rows = await h.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM operator_actions WHERE review_queue_id = $1`,
      [id],
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it('correct_extraction rejects reviewer free-text / raw PII (enums only → REQUEST_MALFORMED)', async () => {
    const id = await h.seedHeld('test-sec-review-correct', { reason: 'schema_invalid' });
    const session = await h.login();
    const res = await postAction(h, session, id, 'correct_extraction', {
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
      // A smuggled free-text PII field — the strict enums-only schema must reject it.
      problem_statement: PII_SEEDS.customerLanguage,
    });
    expect(res.status).toBe(400);
    expect((res.json() as { error: string }).error).toBe('REQUEST_MALFORMED');
    expect(await operatorActionCount()).toBe(0);
    assertNoPrototypePollution();
  });
});

/* =================================================================================================
 * Knowledge-base surface (10.1) — read-only, highest PII risk.
 * ============================================================================================== */

describe.skipIf(!hasTestDb)('knowledge-base surface (10.1) — security matrix', () => {
  let owner: Pool;
  let app: Pool;
  const PATTERN = 'test-sec-kb-%';

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(() => cleanupCalls(owner, PATTERN));
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  // A benign, PII-free row so the read matrix has content to render.
  async function seedBenign(): Promise<void> {
    await seedKnowledge(owner, app, {
      callId: 'test-sec-kb-benign',
      createdAt: '2026-06-01T00:00:00.000Z',
      problemStatement: 'water heater not heating',
      symptoms: ['no hot water'],
      customerLanguage: ['it stopped working yesterday'],
    });
  }

  describe('shared read matrix', () => {
    let harness: InternalHarness;
    beforeEach(async () => {
      await seedBenign();
      harness = await makeKnowledgeHarness(app, { config: {} });
    });
    afterEach(() => harness.app.close());

    runReadPathMatrix({
      getApp: () => harness.app,
      login: () => login(harness),
      readPaths: [
        { path: '/knowledge', kind: 'html' },
        { path: '/knowledge.json', kind: 'json' },
        { path: '/knowledge/export.csv', kind: 'json' },
        { path: '/knowledge/export.json', kind: 'json' },
      ],
      rateLimit: { makeApp: makeRateLimitProbeApp, path: '/probe', max: 3 },
    });
  });

  it('scrubs labeled-PII-corpus values from JSON, CSV, JSON export, and the summary', async () => {
    // Seed content fields carrying PII seeds; the deny-list egress guard must scrub every one.
    await seedKnowledge(owner, app, {
      callId: 'test-sec-kb-pii',
      createdAt: '2026-06-02T00:00:00.000Z',
      problemStatement: `caller ${PII_SEEDS.name} said`,
      symptoms: [PII_SEEDS.phone],
      customerLanguage: [PII_SEEDS.customerLanguage, PII_SEEDS.email],
      concerns: [PII_SEEDS.address],
    });
    const harness = await makeKnowledgeHarness(app, { denyTerms: [...ALL_PII_SEEDS] });
    const { cookie } = await login(harness);

    for (const url of [
      '/knowledge',
      '/knowledge.json',
      '/knowledge/export.csv',
      '/knowledge/export.json',
    ]) {
      const res = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      assertNoPii(res.payload, url);
    }
    await harness.app.close();
  });

  it('CSV and JSON exports agree on the filtered view (parity)', async () => {
    await seedKnowledge(owner, app, {
      callId: 'test-sec-kb-p1',
      createdAt: '2026-06-03T00:00:00.000Z',
      serviceCategory: 'water_heater',
    });
    await seedKnowledge(owner, app, {
      callId: 'test-sec-kb-p2',
      createdAt: '2026-06-04T00:00:00.000Z',
      serviceCategory: 'water_heater',
    });
    const harness = await makeKnowledgeHarness(app);
    const { cookie } = await login(harness);
    const jsonRes = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.json?service_category=water_heater',
      headers: { cookie },
    });
    const csvRes = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv?service_category=water_heater',
      headers: { cookie },
    });
    const jsonRows = jsonRes.json<{ results: { call_id: string }[] }>().results;
    const csvDataLines = csvRes.payload.trim().split('\n').slice(1); // drop header row
    expect(csvDataLines.length).toBe(jsonRows.length);
    for (const row of jsonRows) {
      expect(csvRes.payload).toContain(row.call_id);
    }
    await harness.app.close();
  });

  it('reads ONLY structured_knowledge — the source never references restricted tables', () => {
    // Static backstop mirroring test/db/restricted-import-guard.test.ts: no knowledge module may
    // touch raw_transcripts / token_vault / match_keys in a SQL clause.
    const dir = fileURLToPath(new URL('../../src/knowledge/', import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const forbidden =
      /\b(?:from|into|update|join)\s+(?:"?\w+"?\.)?"?(?:raw_transcripts|token_vault|match_keys)\b/i;
    const offenders = files.filter((f) => forbidden.test(readFileSync(`${dir}${f}`, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
