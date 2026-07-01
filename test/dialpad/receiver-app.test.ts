import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryRateStore, MemoryReplayStore } from '../../src/http/index.js';
import { makeTestConfig } from '../_config.js';
import { FakeClock } from '../http/_helpers.js';
import { buildWebhookReceiverApp } from '../../src/dialpad/webhook/receiver-app.js';
import type { DialpadIngestEvent, DialpadIngestSink } from '../../src/dialpad/webhook/sink.js';

const PRIMARY = 'dialpad-primary-secret-0123456789';
const HASH = 'pii-hash-secret-0123456789abcdef';

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

class FakeSink implements DialpadIngestSink {
  events: DialpadIngestEvent[] = [];
  ingest(event: DialpadIngestEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** The service wiring (createWebhookApp + single parser install + route) boots and responds. */
describe('buildWebhookReceiverApp', () => {
  it('assembles a working receiver: valid event returns 200 and ingests once', async () => {
    const clock = new FakeClock();
    const config = makeTestConfig({
      DIALPAD_WEBHOOK_SECRET: PRIMARY,
      DIALPAD_PII_HASH_SECRET: HASH,
    });
    const sink = new FakeSink();
    const webhookApp = await buildWebhookReceiverApp({
      config,
      replayStore: new MemoryReplayStore(clock),
      rateStore: new MemoryRateStore(clock),
      sink,
      clock,
    });
    await webhookApp.app.ready();

    const token = signJwt(
      { call_id: '555', event_id: 'e1', iat: Math.floor(clock.now() / 1000) },
      PRIMARY,
    );
    const res = await webhookApp.app.inject({
      method: 'POST',
      url: '/webhooks/dialpad',
      headers: { 'content-type': 'application/json' },
      payload: token,
    });
    expect(res.statusCode).toBe(200);
    expect(sink.events).toHaveLength(1);
    await webhookApp.app.close();
  });

  it('fails to assemble when a required secret is missing (CONFIG_MISSING_OR_INVALID)', async () => {
    const clock = new FakeClock();
    const config = makeTestConfig({ DIALPAD_WEBHOOK_SECRET: PRIMARY }); // no PII hash secret
    await expect(
      buildWebhookReceiverApp({
        config,
        replayStore: new MemoryReplayStore(clock),
        rateStore: new MemoryRateStore(clock),
        sink: new FakeSink(),
        clock,
      }),
    ).rejects.toMatchObject({ error_code: 'CONFIG_MISSING_OR_INVALID' });
  });
});
