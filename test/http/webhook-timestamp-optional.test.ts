import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { hmacSha256Hex, timingSafeEqualHex } from '../../src/http/index.js';
import { makeWebhookApp, FakeClock } from './_helpers.js';

const SECRET = 'webhook-signing-secret';

function verifySignature(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const provided = headers['x-signature'];
  return (
    typeof provided === 'string' && timingSafeEqualHex(provided, hmacSha256Hex(rawBody, SECRET))
  );
}

/**
 * A provider that signs no timestamp: extractTimestamp is omitted, so the freshness gate is
 * skipped. Replay protection must still apply. (Existing webhooks keep extractTimestamp and are
 * covered by webhook.test.ts.)
 */
describe('webhook app — optional timestamp (unsupported mode)', () => {
  async function setup() {
    const clock = new FakeClock();
    const { webhookApp } = await makeWebhookApp({}, clock);
    const events: string[] = [];
    webhookApp.registerWebhook({
      path: '/webhooks/no-ts',
      provider: 'no-ts',
      verifySignature,
      extractEventId: (raw) => {
        const parsed = JSON.parse(raw.toString('utf8')) as { id?: unknown };
        if (typeof parsed.id !== 'string') throw new Error('missing id');
        return parsed.id;
      },
      // extractTimestamp intentionally omitted.
      handler: (request) => {
        events.push((request.body as { id: string }).id);
        return { ok: true };
      },
    });
    await webhookApp.app.ready();
    const inject = (id: string, signature?: string) => {
      const body = JSON.stringify({ id }); // no `ts` field at all
      return webhookApp.app.inject({
        method: 'POST',
        url: '/webhooks/no-ts',
        headers: {
          'content-type': 'application/json',
          'x-signature': signature ?? hmacSha256Hex(Buffer.from(body), SECRET),
        },
        payload: body,
      });
    };
    return { inject, events };
  }

  it('accepts a valid signed event that carries no timestamp', async () => {
    const h = await setup();
    const res = await h.inject('evt-1');
    expect(res.statusCode).toBe(200);
    expect(h.events).toEqual(['evt-1']);
  });

  it('still enforces replay protection', async () => {
    const h = await setup();
    const first = await h.inject('dup');
    const second = await h.inject('dup');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'WEBHOOK_REPLAY_DETECTED' });
    expect(h.events).toEqual(['dup']);
  });

  it('still rejects an invalid signature', async () => {
    const h = await setup();
    const res = await h.inject('evt-x', 'deadbeef');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'WEBHOOK_SIGNATURE_INVALID' });
  });
});
