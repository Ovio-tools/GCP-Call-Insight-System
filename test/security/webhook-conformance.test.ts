import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import type { LightMyRequestResponse } from 'fastify';
import { hmacSha256Hex, timingSafeEqualHex } from '../../src/http/index.js';
import type { Config } from '../../src/config/schema.js';
import { makeWebhookApp, FakeClock } from '../http/_helpers.js';
import { assertNoPii, expectMiddlewareError, PII_SEEDS } from './_security-suite.js';

/**
 * The `sharedFactorySuite` for every webhook surface (Task 9.1) — a SYNTHETIC factory proof, never a
 * real-surface proof (a live webhook surface must ALSO have its own `liveSuite`; conformance
 * assertion (c2) enforces that). A minimal inline-HMAC provider drives `createWebhookApp` +
 * `registerWebhook` so the factory-enforced chain is proven independent of any surface:
 * sig → timestamp → replay → rate-limit → oversized, with the handler spy un-called on every reject.
 *
 * This is the template a new webhook surface must satisfy in its own real suite before going live.
 */

const SECRET = 'webhook-conformance-secret-0123456789';

function sign(rawBody: string): string {
  return hmacSha256Hex(Buffer.from(rawBody), SECRET);
}

function verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const provided = headers['x-signature'];
  return (
    typeof provided === 'string' && timingSafeEqualHex(provided, hmacSha256Hex(rawBody, SECRET))
  );
}

interface Harness {
  inject: (opts: {
    id?: string;
    ts: number;
    signature?: string;
    omitId?: boolean;
    extra?: Record<string, unknown>;
    contentType?: string;
    payload?: string;
  }) => Promise<LightMyRequestResponse>;
  handlerCalls: string[];
  clock: FakeClock;
}

async function setup(overrides: Partial<Config> = {}): Promise<Harness> {
  const clock = new FakeClock();
  const { webhookApp } = await makeWebhookApp(overrides, clock);
  const handlerCalls: string[] = [];

  webhookApp.registerWebhook({
    path: '/webhooks/synthetic',
    provider: 'synthetic',
    verifySignature,
    extractEventId: (raw) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { id?: unknown };
      if (typeof parsed.id !== 'string') throw new Error('missing id');
      return parsed.id;
    },
    extractTimestamp: (raw) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { ts?: unknown };
      return typeof parsed.ts === 'number' ? parsed.ts : Number.NaN;
    },
    handler: (request) => {
      const body = request.body as { id: string };
      handlerCalls.push(body.id);
      return { received: true };
    },
  });
  await webhookApp.app.ready();

  return {
    handlerCalls,
    clock,
    inject: ({ id = 'evt-1', ts, signature, omitId = false, extra = {}, contentType, payload }) => {
      const payloadObj: Record<string, unknown> = { ts, ...extra };
      if (!omitId) payloadObj.id = id;
      const body = payload ?? JSON.stringify(payloadObj);
      return webhookApp.app.inject({
        method: 'POST',
        url: '/webhooks/synthetic',
        headers: {
          'content-type': contentType ?? 'application/json',
          'x-signature': signature ?? sign(body),
        },
        payload: body,
      });
    },
  };
}

describe('webhook factory conformance (synthetic provider — sharedFactorySuite)', () => {
  it('accepts a valid, fresh, signed event exactly once', async () => {
    const h = await setup();
    const res = await h.inject({ id: 'ok', ts: h.clock.now() });
    expect(res.statusCode).toBe(200);
    expect(h.handlerCalls).toEqual(['ok']);
  });

  it('rejects a missing signature (401) and never runs the handler', async () => {
    const h = await setup();
    const res = await h.inject({ id: 'x', ts: h.clock.now(), signature: '' });
    expectMiddlewareError(res, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.handlerCalls).toEqual([]);
  });

  it('rejects an invalid signature (401) and reserves no replay entry', async () => {
    const h = await setup();
    const bad = await h.inject({ id: 'y', ts: h.clock.now(), signature: 'deadbeef' });
    expectMiddlewareError(bad, 'WEBHOOK_SIGNATURE_INVALID');
    expect(h.handlerCalls).toEqual([]);
    // Same id with a valid signature now succeeds — the bad request reserved nothing.
    const good = await h.inject({ id: 'y', ts: h.clock.now() });
    expect(good.statusCode).toBe(200);
    expect(h.handlerCalls).toEqual(['y']);
  });

  it('rejects a stale timestamp (400)', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const res = await h.inject({ ts: h.clock.now() - 5000 });
    expectMiddlewareError(res, 'WEBHOOK_TIMESTAMP_INVALID');
    expect(h.handlerCalls).toEqual([]);
  });

  it('rejects a future timestamp (400)', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const res = await h.inject({ ts: h.clock.now() + 5000 });
    expectMiddlewareError(res, 'WEBHOOK_TIMESTAMP_INVALID');
    expect(h.handlerCalls).toEqual([]);
  });

  it('rejects an event whose id cannot be extracted (400)', async () => {
    const h = await setup();
    const res = await h.inject({ ts: h.clock.now(), omitId: true });
    expectMiddlewareError(res, 'REQUEST_MALFORMED');
    expect(h.handlerCalls).toEqual([]);
  });

  it('rejects a replayed event id (409) after a successful handler', async () => {
    const h = await setup();
    const first = await h.inject({ id: 'dup', ts: h.clock.now() });
    const second = await h.inject({ id: 'dup', ts: h.clock.now() });
    expect(first.statusCode).toBe(200);
    expectMiddlewareError(second, 'WEBHOOK_REPLAY_DETECTED');
    expect(h.handlerCalls).toEqual(['dup']); // handler ran exactly once
  });

  it('trips the per-provider rate limit (429) before signature verification', async () => {
    const h = await setup({ WEBHOOK_RATE_LIMIT_MAX: 2 });
    const r1 = await h.inject({ id: 'r1', ts: h.clock.now(), signature: 'bad' });
    const r2 = await h.inject({ id: 'r2', ts: h.clock.now(), signature: 'bad' });
    const r3 = await h.inject({ id: 'r3', ts: h.clock.now(), signature: 'bad' });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expectMiddlewareError(r3, 'RATE_LIMIT_EXCEEDED');
    expect(h.handlerCalls).toEqual([]);
  });

  it('rejects an oversized body (413)', async () => {
    const h = await setup();
    const res = await h.inject({ ts: h.clock.now(), payload: 'x'.repeat(1_200_000) });
    expectMiddlewareError(res, 'REQUEST_BODY_TOO_LARGE');
    expect(h.handlerCalls).toEqual([]);
  });

  it('never echoes planted PII in a rejection response', async () => {
    const h = await setup();
    const res = await h.inject({
      id: 'evt',
      ts: h.clock.now(),
      signature: 'bad',
      extra: { transcript: PII_SEEDS.customerLanguage, caller: PII_SEEDS.email },
    });
    expect(res.statusCode).toBe(401);
    assertNoPii(res.payload);
    expect(h.handlerCalls).toEqual([]);
  });
});
