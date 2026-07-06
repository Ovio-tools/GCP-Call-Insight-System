import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import { MemoryRateStore, MemoryReplayStore } from '../../src/http/index.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { repositories } from '../../src/db/index.js';
import type { Config } from '../../src/config/schema.js';
import type { PipelineJobData } from '../../src/queue/pipeline-queue.js';
import { makeTestConfig } from '../_config.js';
import { FakeClock } from '../http/_helpers.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';
import { buildWebhookReceiverApp } from '../../src/dialpad/webhook/receiver-app.js';
import { createPgIngestSink } from '../../src/dialpad/webhook/sink.js';
import type { DialpadIngestEvent, DialpadIngestSink } from '../../src/dialpad/webhook/sink.js';
import {
  assertNoPii,
  expectMiddlewareError,
  PII_SEEDS,
  signAlgNoneJwt,
  signJwt,
  tamperJwt,
} from './_security-suite.js';

/**
 * The REAL Dialpad receiver `liveSuite` (Task 9.1) — the fully-assembled `buildWebhookReceiverApp`
 * (createWebhookApp + the single raw-body parser + the Dialpad route) driven through the
 * cross-cutting security matrix + the Task 3.2 side-effect contract. Reuses the `FakeSink`/`signJwt`
 * seam pattern from `test/dialpad/`.
 *
 * Task 3.2's own `test/dialpad/webhook-route.test.ts` already covers much of the chain; this suite
 * adds the MATRIX LENS and fills gaps by REUSING those helpers, not duplicating them. NET-NEW here:
 * the `alg:none` forgery, the shared `tamperJwt` variant, the full `PII_SEEDS` egress battery over
 * response + logs + the stored audit row, and the oversized/non-JWT rejection framed in matrix codes.
 */

const PRIMARY = 'dialpad-primary-secret-0123456789';
const HASH = 'pii-hash-secret-0123456789abcdef';

class FakeSink implements DialpadIngestSink {
  events: DialpadIngestEvent[] = [];
  ingest(event: DialpadIngestEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

function capturingLogger(): { logger: ReturnType<typeof createRootLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger({
    level: 'info',
    name: 'test-dialpad-security',
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  return { logger, lines };
}

interface Harness {
  inject: (body: string, contentType?: string) => Promise<LightMyRequestResponse>;
  sink: FakeSink;
  clock: FakeClock;
  lines: string[];
}

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const clock = new FakeClock();
  const config = makeTestConfig({
    DIALPAD_WEBHOOK_SECRET: PRIMARY,
    DIALPAD_PII_HASH_SECRET: HASH,
    ...overrides,
  });
  const { logger, lines } = capturingLogger();
  const sink = new FakeSink();
  const webhookApp = await buildWebhookReceiverApp({
    config,
    replayStore: new MemoryReplayStore(clock),
    rateStore: new MemoryRateStore(clock),
    sink,
    logger,
    clock,
  });
  await webhookApp.app.ready();
  return {
    sink,
    clock,
    lines,
    inject: (body, contentType = 'application/json') =>
      webhookApp.app.inject({
        method: 'POST',
        url: '/webhooks/dialpad',
        headers: { 'content-type': contentType },
        payload: body,
      }),
  };
}

function freshClaims(
  clock: FakeClock,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { call_id: '555', event_id: 'evt-1', iat: Math.floor(clock.now() / 1000), ...extra };
}

describe('Dialpad webhook surface — valid event side effects (liveSuite)', () => {
  it('accepts a valid signed event, ingests exactly once, returns 200', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt(freshClaims(h.clock, { direction: 'inbound', state: 'connected' }), PRIMARY),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(h.sink.events).toHaveLength(1);
    expect(h.sink.events[0]!.callId).toBe('555');
  });

  it('stores only allowlisted metadata with phone/name hashed; no content, no PII seeds', async () => {
    const h = await setup();
    await h.inject(
      signJwt(
        freshClaims(h.clock, {
          direction: 'inbound',
          state: 'connected',
          contact: { name: PII_SEEDS.name, phone: PII_SEEDS.phone },
          transcript: PII_SEEDS.customerLanguage,
          note: PII_SEEDS.address,
        }),
        PRIMARY,
      ),
    );
    const e = h.sink.events[0]!;
    const audit = JSON.stringify(e.auditPayload);
    const source = JSON.stringify(e.sourceMetadata);
    // Raw phone/name/content never stored in clear.
    assertNoPii(audit, 'audit row');
    assertNoPii(source, 'source_metadata');
    expect(audit).not.toContain('transcript');
    expect(audit).not.toContain('note');
    // But the hashed references ARE present (phone/name appeared).
    expect(e.auditPayload.phone_hmac).toBeDefined();
    expect(e.auditPayload.name_hmac).toBeDefined();
    // The indefinitely-retained source_metadata carries no hashes at all.
    expect(source).not.toContain('hmac');
  });
});

describe('Dialpad webhook surface — rejections before any work (matrix)', () => {
  it('rejects an invalid signature (wrong secret) → WEBHOOK_SIGNATURE_INVALID, sink un-called', async () => {
    const h = await setup();
    const res = await h.inject(signJwt(freshClaims(h.clock), 'the-wrong-secret-000000000000000'));
    expectMiddlewareError(res, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects an alg:none (unsigned) forgery → WEBHOOK_SIGNATURE_INVALID, sink un-called', async () => {
    const h = await setup();
    const res = await h.inject(signAlgNoneJwt(freshClaims(h.clock)));
    expectMiddlewareError(res, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a tampered signature → WEBHOOK_SIGNATURE_INVALID, sink un-called', async () => {
    const h = await setup();
    const res = await h.inject(tamperJwt(signJwt(freshClaims(h.clock), PRIMARY)));
    expectMiddlewareError(res, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a non-JWT / unsigned body → WEBHOOK_SIGNATURE_INVALID, sink un-called', async () => {
    const h = await setup();
    const res = await h.inject('not-a-jwt-at-all');
    expectMiddlewareError(res, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a replayed event id → WEBHOOK_REPLAY_DETECTED, ingests once', async () => {
    const h = await setup();
    const token = signJwt(freshClaims(h.clock), PRIMARY);
    const first = await h.inject(token);
    const second = await h.inject(token);
    expect(first.statusCode).toBe(200);
    expectMiddlewareError(second, 'WEBHOOK_REPLAY_DETECTED');
    expect(h.sink.events).toHaveLength(1);
  });

  it('rejects a stale timestamp → WEBHOOK_TIMESTAMP_INVALID, sink un-called', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const staleIat = Math.floor((h.clock.now() - 5000) / 1000);
    const res = await h.inject(signJwt({ call_id: '555', event_id: 'e', iat: staleIat }, PRIMARY));
    expectMiddlewareError(res, 'WEBHOOK_TIMESTAMP_INVALID');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a valid-signature event missing call_id → REQUEST_MALFORMED, sink un-called', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt({ event_id: 'evt-x', iat: Math.floor(h.clock.now() / 1000) }, PRIMARY),
    );
    expectMiddlewareError(res, 'REQUEST_MALFORMED');
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects an oversized body → REQUEST_BODY_TOO_LARGE, sink un-called', async () => {
    const h = await setup({ HTTP_MAX_BODY_BYTES: 256 });
    const big = signJwt(freshClaims(h.clock, { pad: 'x'.repeat(5000) }), PRIMARY);
    const res = await h.inject(big);
    expectMiddlewareError(res, 'REQUEST_BODY_TOO_LARGE');
    expect(h.sink.events).toHaveLength(0);
  });
});

describe('Dialpad webhook surface — PII egress', () => {
  it('never leaks planted PII to the response or the logs on a rejected event', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt(
        freshClaims(h.clock, {
          contact_name: PII_SEEDS.name,
          phone: PII_SEEDS.phone,
          transcript: PII_SEEDS.customerLanguage,
          email: PII_SEEDS.email,
        }),
        'the-wrong-secret-000000000000000',
      ),
    );
    expect(res.statusCode).toBe(401);
    assertNoPii(res.payload, 'response');
    assertNoPii(h.lines.join('\n'), 'logs');
  });

  it('never leaks planted PII to the logs on an accepted event', async () => {
    const h = await setup();
    await h.inject(
      signJwt(
        freshClaims(h.clock, { contact: { name: PII_SEEDS.name, phone: PII_SEEDS.phone } }),
        PRIMARY,
      ),
    );
    assertNoPii(h.lines.join('\n'), 'logs');
  });
});

/**
 * The real DB/queue side-effect proof, so `npm run test:security` itself owns the live-surface claim
 * ("call_state seed + minimized audit row + one enqueue") rather than leaning on the FakeSink above
 * (the separate `test/dialpad/pg-ingest-sink.test.ts` proves the sink in isolation; this drives it
 * end-to-end through the real receiver). Redis is avoided with a stub queue.
 */
describe.skipIf(!hasTestDb)(
  'Dialpad webhook surface — real DB/queue side effects (liveSuite)',
  () => {
    let owner: Pool;
    let app: Pool;
    const PATTERN = 'test-sec-dp-%';
    const added: string[] = [];
    const stubQueue = {
      add: (_name: string, data: PipelineJobData) => {
        added.push(data.callId);
        return Promise.resolve({});
      },
    } as unknown as Queue<PipelineJobData>;

    async function dbReceiver(): Promise<{ recv: FastifyInstance; clock: FakeClock }> {
      const clock = new FakeClock();
      const config = makeTestConfig({
        DIALPAD_WEBHOOK_SECRET: PRIMARY,
        DIALPAD_PII_HASH_SECRET: HASH,
      });
      const sink = createPgIngestSink({ pool: app, queue: stubQueue, config });
      const webhookApp = await buildWebhookReceiverApp({
        config,
        replayStore: new MemoryReplayStore(clock),
        rateStore: new MemoryRateStore(clock),
        sink,
        clock,
      });
      await webhookApp.app.ready();
      return { recv: webhookApp.app, clock };
    }

    const wipe = async (): Promise<void> => {
      added.length = 0;
      await owner.query(`DELETE FROM raw_webhook_events WHERE source = 'dialpad-webhook'`);
      await cleanupCalls(owner, PATTERN);
    };

    beforeAll(async () => {
      await migrate('up');
      owner = makePool();
      app = makeAppPool();
    });
    beforeEach(wipe);
    afterAll(async () => {
      await wipe();
      await owner.end();
      await app.end();
    });

    it('a valid signed event seeds call_state, writes a minimized audit row (phone/name hashed), enqueues once', async () => {
      const { recv, clock } = await dbReceiver();
      const callId = 'test-sec-dp-ok';
      const token = signJwt(
        {
          call_id: callId,
          event_id: 'dp-e1',
          iat: Math.floor(clock.now() / 1000),
          direction: 'inbound',
          state: 'connected',
          contact_name: PII_SEEDS.name,
          phone: PII_SEEDS.phone,
          transcript: PII_SEEDS.customerLanguage,
        },
        PRIMARY,
      );
      const res = await recv.inject({
        method: 'POST',
        url: '/webhooks/dialpad',
        headers: { 'content-type': 'application/json' },
        payload: token,
      });
      expect(res.statusCode).toBe(200);

      // call_state seeded at stage 0, with only the non-PII allowlisted source_metadata.
      const state = await repositories.callState.getCallState(app, callId);
      expect(state?.current_stage).toBe('metadata-pre-filter');
      assertNoPii(JSON.stringify(state?.source_metadata), 'call_state.source_metadata');
      expect(JSON.stringify(state?.source_metadata)).not.toContain('hmac');

      // Exactly one minimized raw_webhook_events row: allowlisted metadata + hashed phone/name, no
      // raw PII, no transcript/content.
      const audit = await owner.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM raw_webhook_events
        WHERE source = 'dialpad-webhook' AND payload->>'call_id' = $1`,
        [callId],
      );
      expect(audit.rows).toHaveLength(1);
      const payload = audit.rows[0]!.payload;
      assertNoPii(JSON.stringify(payload), 'raw_webhook_events');
      expect(payload.phone_hmac).toBeDefined();
      expect(payload.name_hmac).toBeDefined();
      expect(JSON.stringify(payload)).not.toContain('transcript');

      // Exactly one enqueue keyed by call_id.
      expect(added).toEqual([callId]);
      await recv.close();
    });

    it('an invalid-signature event writes no row, seeds no call_state, enqueues nothing', async () => {
      const { recv, clock } = await dbReceiver();
      const callId = 'test-sec-dp-bad';
      const token = signJwt(
        { call_id: callId, event_id: 'dp-bad', iat: Math.floor(clock.now() / 1000) },
        'the-wrong-secret-000000000000000',
      );
      const res = await recv.inject({
        method: 'POST',
        url: '/webhooks/dialpad',
        headers: { 'content-type': 'application/json' },
        payload: token,
      });
      expect(res.statusCode).toBe(401);

      const audit = await owner.query(
        `SELECT 1 FROM raw_webhook_events WHERE source = 'dialpad-webhook' AND payload->>'call_id' = $1`,
        [callId],
      );
      expect(audit.rows).toHaveLength(0);
      expect(await repositories.callState.getCallState(app, callId)).toBeFalsy();
      expect(added).toEqual([]);
      await recv.close();
    });
  },
);
