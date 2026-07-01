import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import type { LightMyRequestResponse } from 'fastify';
import { hmacSha256Hex, timingSafeEqualHex } from '../../src/http/index.js';
import type { Config } from '../../src/config/schema.js';
import { makeWebhookApp, FakeClock } from './_helpers.js';

const SECRET = 'webhook-signing-secret';

function sign(rawBody: string): string {
  return hmacSha256Hex(Buffer.from(rawBody), SECRET);
}

function verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const provided = headers['x-signature'];
  return (
    typeof provided === 'string' && timingSafeEqualHex(provided, hmacSha256Hex(rawBody, SECRET))
  );
}

interface WebhookHarness {
  inject: (opts: {
    id?: string;
    ts: number;
    signature?: string;
    omitId?: boolean;
    extra?: Record<string, unknown>;
  }) => Promise<LightMyRequestResponse>;
  events: string[];
  clock: FakeClock;
  lines: string[];
  setThrow: (v: boolean) => void;
}

async function setup(overrides: Partial<Config> = {}): Promise<WebhookHarness> {
  const clock = new FakeClock();
  const { webhookApp, lines } = await makeWebhookApp(overrides, clock);
  const events: string[] = [];
  let shouldThrow = false;

  webhookApp.registerWebhook({
    path: '/webhooks/test',
    provider: 'test',
    verifySignature,
    extractEventId: (raw) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { id?: unknown };
      if (typeof parsed.id !== 'string') {
        throw new Error('missing id');
      }
      return parsed.id;
    },
    extractTimestamp: (raw) => {
      const parsed = JSON.parse(raw.toString('utf8')) as { ts?: unknown };
      return typeof parsed.ts === 'number' ? parsed.ts : Number.NaN;
    },
    handler: (request) => {
      if (shouldThrow) {
        throw new Error('handler failure');
      }
      const body = request.body as { id: string };
      events.push(body.id);
      return { ok: true };
    },
  });
  await webhookApp.app.ready();

  return {
    events,
    clock,
    lines,
    setThrow: (v) => {
      shouldThrow = v;
    },
    inject: ({ id = 'evt-1', ts, signature, omitId = false, extra = {} }) => {
      const payloadObj: Record<string, unknown> = { ts, ...extra };
      if (!omitId) {
        payloadObj.id = id;
      }
      const body = JSON.stringify(payloadObj);
      return webhookApp.app.inject({
        method: 'POST',
        url: '/webhooks/test',
        headers: { 'content-type': 'application/json', 'x-signature': signature ?? sign(body) },
        payload: body,
      });
    },
  };
}

describe('webhook app — verification chain', () => {
  it('accepts a valid, fresh, signed webhook and runs the handler', async () => {
    const h = await setup();
    const res = await h.inject({ id: 'evt-ok', ts: h.clock.now() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(h.events).toEqual(['evt-ok']);
  });

  it('rejects an invalid signature and does not run the handler or record a replay entry', async () => {
    const h = await setup();
    const bad = await h.inject({ id: 'evt-x', ts: h.clock.now(), signature: 'deadbeef' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ error: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(h.events).toEqual([]);

    // Same id with a VALID signature now succeeds — proving the bad request reserved nothing.
    const good = await h.inject({ id: 'evt-x', ts: h.clock.now() });
    expect(good.statusCode).toBe(200);
    expect(h.events).toEqual(['evt-x']);
  });

  it('rejects a stale timestamp', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const res = await h.inject({ ts: h.clock.now() - 2000 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'WEBHOOK_TIMESTAMP_INVALID' });
    expect(h.events).toEqual([]);
  });

  it('rejects a future timestamp', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const res = await h.inject({ ts: h.clock.now() + 2000 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'WEBHOOK_TIMESTAMP_INVALID' });
    expect(h.events).toEqual([]);
  });

  it('rejects a webhook whose event id cannot be extracted', async () => {
    const h = await setup();
    const res = await h.inject({ ts: h.clock.now(), omitId: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'REQUEST_MALFORMED' });
    expect(h.events).toEqual([]);
  });
});

describe('webhook app — replay reserve/commit', () => {
  it('rejects a duplicate event id after a successful handler', async () => {
    const h = await setup();
    const first = await h.inject({ id: 'dup', ts: h.clock.now() });
    const second = await h.inject({ id: 'dup', ts: h.clock.now() });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'WEBHOOK_REPLAY_DETECTED' });
    expect(h.events).toEqual(['dup']); // handler ran exactly once
  });

  it('accepts a distinct event id', async () => {
    const h = await setup();
    await h.inject({ id: 'a', ts: h.clock.now() });
    const res = await h.inject({ id: 'b', ts: h.clock.now() });
    expect(res.statusCode).toBe(200);
    expect(h.events).toEqual(['a', 'b']);
  });

  it('accepts a retry after the handler fails (reservation released)', async () => {
    const h = await setup();
    h.setThrow(true);
    const failed = await h.inject({ id: 'retryable', ts: h.clock.now() });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: 'INTERNAL_ERROR' });

    h.setThrow(false);
    const retry = await h.inject({ id: 'retryable', ts: h.clock.now() });
    expect(retry.statusCode).toBe(200);
    expect(h.events).toEqual(['retryable']);
  });

  it('accepts the same id again once the replay window has expired', async () => {
    const h = await setup({ WEBHOOK_REPLAY_WINDOW_MS: 1000 });
    const first = await h.inject({ id: 'expiring', ts: h.clock.now() });
    expect(first.statusCode).toBe(200);

    h.clock.advance(1001);
    const again = await h.inject({ id: 'expiring', ts: h.clock.now() });
    expect(again.statusCode).toBe(200);
    expect(h.events).toEqual(['expiring', 'expiring']);
  });
});

describe('webhook app — rate limit & PII', () => {
  it('trips the per-provider rate limit before signature verification', async () => {
    const h = await setup({ WEBHOOK_RATE_LIMIT_MAX: 2 });
    // Bad signatures still consume the rate budget (limiter runs onRequest).
    const r1 = await h.inject({ id: 'r1', ts: h.clock.now(), signature: 'bad' });
    const r2 = await h.inject({ id: 'r2', ts: h.clock.now(), signature: 'bad' });
    const r3 = await h.inject({ id: 'r3', ts: h.clock.now(), signature: 'bad' });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
    expect(r3.statusCode).toBe(429);
    expect(r3.json()).toMatchObject({ error: 'RATE_LIMIT_EXCEEDED' });
  });

  it('never echoes planted PII in a rejection response', async () => {
    const h = await setup();
    const pii = 'secret-caller@example.com';
    const res = await h.inject({
      id: 'evt',
      ts: h.clock.now(),
      signature: 'bad',
      extra: { transcript: pii },
    });
    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toContain(pii);
    const body: Record<string, unknown> = res.json();
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'request_id']);
  });
});
