import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { createWebhookApp, MemoryRateStore, MemoryReplayStore } from '../../src/http/index.js';
import { ConfigError } from '../../src/config/index.js';
import { createRootLogger } from '../../src/logging/logger.js';
import type { Config } from '../../src/config/schema.js';
import { makeTestConfig } from '../_config.js';
import { FakeClock } from '../http/_helpers.js';
import {
  installDialpadBodyParser,
  registerDialpadWebhook,
} from '../../src/dialpad/webhook/route.js';
import type { DialpadIngestEvent, DialpadIngestSink } from '../../src/dialpad/webhook/sink.js';

const PRIMARY = 'dialpad-primary-secret-0123456789';
const PREVIOUS = 'dialpad-previous-secret-abcdef0000';
const HASH = 'pii-hash-secret-0123456789abcdef';

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/** Sign a Dialpad-style JWT (whole body = token). iat is in seconds. */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

class FakeSink implements DialpadIngestSink {
  events: DialpadIngestEvent[] = [];
  fail = false;
  ingest(event: DialpadIngestEvent): Promise<void> {
    if (this.fail) return Promise.reject(new Error('sink failure'));
    this.events.push(event);
    return Promise.resolve();
  }
}

function capturingLogger(): { logger: ReturnType<typeof createRootLogger>; lines: string[] } {
  const lines: string[] = [];
  const logger = createRootLogger({
    level: 'info',
    name: 'test-dialpad',
    destination: { write: (chunk: string) => lines.push(chunk) },
  });
  return { logger, lines };
}

interface Harness {
  inject: (token: string, contentType?: string) => Promise<LightMyRequestResponse>;
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
  const webhookApp = await createWebhookApp({
    config,
    replayStore: new MemoryReplayStore(clock),
    rateStore: new MemoryRateStore(clock),
    clock,
    logger,
  });
  // Mirror the service: the single owner installs the raw-body parser before route registration.
  installDialpadBodyParser(webhookApp.app);
  const sink = new FakeSink();
  registerDialpadWebhook(webhookApp, { config, sink, logger, clock });
  await webhookApp.app.ready();

  return {
    sink,
    clock,
    lines,
    inject: (token, contentType = 'application/json') =>
      webhookApp.app.inject({
        method: 'POST',
        url: '/webhooks/dialpad',
        headers: { 'content-type': contentType },
        payload: token,
      }),
  };
}

/** A fresh, valid claim set for the default FakeClock (iat matches now). */
function freshClaims(
  clock: FakeClock,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { call_id: '555', event_id: 'evt-1', iat: Math.floor(clock.now() / 1000), ...extra };
}

describe('Dialpad webhook route — happy path', () => {
  it('accepts a valid signed event, enqueues exactly once, returns 200 fast', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt(freshClaims(h.clock, { direction: 'inbound', state: 'connected' }), PRIMARY),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(h.sink.events).toHaveLength(1);
    const e = h.sink.events[0] as DialpadIngestEvent;
    expect(e.callId).toBe('555');
    expect(e.sourceMetadata).toEqual({ direction: 'inbound', state: 'connected' });
  });

  it('stamps received_at and retention_eligible_at to the same captured clock instant', async () => {
    const h = await setup();
    await h.inject(signJwt(freshClaims(h.clock), PRIMARY));
    const e = h.sink.events[0] as DialpadIngestEvent;
    expect(e.receivedAt.getTime()).toBe(h.clock.now());
    expect(e.retentionEligibleAt.getTime()).toBe(h.clock.now());
    expect(e.receivedAt.getTime()).toBe(e.retentionEligibleAt.getTime());
  });

  it('parses a bare-JWT body even with content-type application/json (catch-all parser)', async () => {
    const h = await setup();
    const res = await h.inject(signJwt(freshClaims(h.clock), PRIMARY), 'application/json');
    expect(res.statusCode).toBe(200);
  });

  it('ingests a real-world alias/nested shape (call.id + nested metadata + internal alias)', async () => {
    // Guards issue #31: a plausible Dialpad payload that does NOT spell the id as top-level
    // `call_id` must still ingest, not hard-fail as REQUEST_MALFORMED.
    const h = await setup();
    const res = await h.inject(
      signJwt(
        {
          event_id: 'evt-nested',
          iat: Math.floor(h.clock.now() / 1000),
          call: { id: 4917123, direction: 'inbound', state: 'connected', duration: 30 },
          internal: false,
        },
        PRIMARY,
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(h.sink.events).toHaveLength(1);
    const e = h.sink.events[0] as DialpadIngestEvent;
    expect(e.callId).toBe('4917123');
    expect(e.sourceMetadata).toEqual({
      direction: 'inbound',
      state: 'connected',
      duration: 30,
      is_internal: false,
    });
  });

  it('still ingests when an optional field has an unexpected type (only that field is dropped)', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt(freshClaims(h.clock, { direction: 'inbound', duration: 'not-a-number' }), PRIMARY),
    );
    expect(res.statusCode).toBe(200);
    const e = h.sink.events[0] as DialpadIngestEvent;
    expect(e.sourceMetadata).toEqual({ direction: 'inbound' }); // duration safely omitted
  });
});

describe('Dialpad webhook route — rejections (no enqueue)', () => {
  it('rejects an invalid signature (wrong secret) with WEBHOOK_SIGNATURE_INVALID', async () => {
    const h = await setup();
    const res = await h.inject(signJwt(freshClaims(h.clock), 'the-wrong-secret-0000000000000000'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a tampered payload', async () => {
    const h = await setup();
    const token = signJwt(freshClaims(h.clock), PRIMARY);
    const [head, , sig] = token.split('.');
    const tampered = `${head}.${b64url(JSON.stringify(freshClaims(h.clock, { call_id: 'attacker' })))}.${sig}`;
    const res = await h.inject(tampered);
    expect(res.statusCode).toBe(401);
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a replayed event id with WEBHOOK_REPLAY_DETECTED and no second enqueue', async () => {
    const h = await setup();
    const token = signJwt(freshClaims(h.clock), PRIMARY);
    const first = await h.inject(token);
    const second = await h.inject(token);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'WEBHOOK_REPLAY_DETECTED' });
    expect(h.sink.events).toHaveLength(1);
  });

  it('accepts two distinct events sharing call_id/state/timestamp (distinct event ids)', async () => {
    const h = await setup();
    const base = { call_id: '555', state: 'connected', iat: Math.floor(h.clock.now() / 1000) };
    const a = await h.inject(signJwt({ ...base, event_id: 'evt-A' }, PRIMARY));
    const b = await h.inject(signJwt({ ...base, event_id: 'evt-B' }, PRIMARY));
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(h.sink.events).toHaveLength(2);
  });

  it('rejects a malformed event (valid signature, missing call_id) with REQUEST_MALFORMED', async () => {
    const h = await setup();
    const res = await h.inject(
      signJwt({ event_id: 'evt-x', iat: Math.floor(h.clock.now() / 1000) }, PRIMARY),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'REQUEST_MALFORMED' });
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects a stale timestamp with WEBHOOK_TIMESTAMP_INVALID', async () => {
    const h = await setup({ WEBHOOK_TIMESTAMP_SKEW_MS: 1000 });
    const staleIat = Math.floor((h.clock.now() - 5000) / 1000);
    const res = await h.inject(signJwt({ call_id: '555', event_id: 'e', iat: staleIat }, PRIMARY));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'WEBHOOK_TIMESTAMP_INVALID' });
    expect(h.sink.events).toHaveLength(0);
  });

  it('rejects an oversized body with REQUEST_BODY_TOO_LARGE (middleware bodyLimit)', async () => {
    const h = await setup({ HTTP_MAX_BODY_BYTES: 64 });
    const big = signJwt(freshClaims(h.clock, { pad: 'x'.repeat(5000) }), PRIMARY);
    const res = await h.inject(big);
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'REQUEST_BODY_TOO_LARGE' });
    expect(h.sink.events).toHaveLength(0);
  });

  it('releases the reservation on handler failure so a legitimate retry is accepted', async () => {
    const h = await setup();
    const token = signJwt(freshClaims(h.clock), PRIMARY);
    h.sink.fail = true;
    const failed = await h.inject(token);
    expect(failed.statusCode).toBe(500);
    h.sink.fail = false;
    const retry = await h.inject(token);
    expect(retry.statusCode).toBe(200);
    expect(h.sink.events).toHaveLength(1);
  });
});

describe('Dialpad webhook route — privacy', () => {
  it('never echoes planted PII in a rejection response', async () => {
    const h = await setup();
    const pii = 'caller@example.com';
    const res = await h.inject(
      signJwt(
        freshClaims(h.clock, { contact_name: 'Jane Doe', transcript: pii }),
        'wrong-secret-000000000000000000',
      ),
    );
    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toContain(pii);
    expect(res.payload).not.toContain('Jane Doe');
    expect(Object.keys(res.json()).sort()).toEqual(['error', 'message', 'request_id']);
  });

  it('never stores planted PII in clear — only allowlisted metadata, phone/name hashed', async () => {
    const h = await setup();
    await h.inject(
      signJwt(
        freshClaims(h.clock, {
          direction: 'inbound',
          state: 'connected',
          contact: { name: 'Jane Doe', phone: '+15551234567' },
          transcript: 'the caller said secret words',
          free_text_note: 'note body',
        }),
        PRIMARY,
      ),
    );
    const e = h.sink.events[0] as DialpadIngestEvent;
    const audit = JSON.stringify(e.auditPayload);
    const source = JSON.stringify(e.sourceMetadata);
    for (const leak of [
      'Jane Doe',
      '+15551234567',
      'secret words',
      'note body',
      'transcript',
      'free_text_note',
    ]) {
      expect(audit, `audit leaked ${leak}`).not.toContain(leak);
      expect(source, `source_metadata leaked ${leak}`).not.toContain(leak);
    }
    expect(e.auditPayload.phone_hmac).toBeDefined();
    expect(e.auditPayload.name_hmac).toBeDefined();
    // call_state.source_metadata (indefinitely retained) carries no hashes at all.
    expect(source).not.toContain('hmac');
  });

  it('logs webhook_key_slot for rotation observability, no PII', async () => {
    const h = await setup({ DIALPAD_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
    // Primary-signed → slot primary.
    await h.inject(signJwt(freshClaims(h.clock, { event_id: 'p1' }), PRIMARY));
    // Previous-signed → accepted during overlap, slot previous.
    await h.inject(signJwt(freshClaims(h.clock, { event_id: 'p2' }), PREVIOUS));
    const joined = h.lines.join('\n');
    expect(joined).toContain('"webhook_key_slot":"primary"');
    expect(joined).toContain('"webhook_key_slot":"previous"');
    expect(joined).not.toContain('+1555');
  });
});

describe('Dialpad webhook route — registration guards', () => {
  async function tryRegister(overrides: Partial<Config>): Promise<ConfigError | null> {
    const clock = new FakeClock();
    const config = makeTestConfig(overrides);
    const webhookApp = await createWebhookApp({
      config,
      replayStore: new MemoryReplayStore(clock),
      rateStore: new MemoryRateStore(clock),
      clock,
    });
    try {
      registerDialpadWebhook(webhookApp, { config, sink: new FakeSink(), clock });
      return null;
    } catch (err) {
      return err as ConfigError;
    }
  }

  it('throws CONFIG_MISSING_OR_INVALID naming DIALPAD_WEBHOOK_SECRET when the signing secret is absent', async () => {
    const err = await tryRegister({ DIALPAD_PII_HASH_SECRET: HASH });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.code).toBe('CONFIG_MISSING_OR_INVALID');
    // The failure must NAME the exact missing variable (CLAUDE.md §5), not just the error code.
    expect(err?.invalid).toEqual(['DIALPAD_WEBHOOK_SECRET']);
    expect(err?.message).toContain('DIALPAD_WEBHOOK_SECRET');
  });

  it('throws CONFIG_MISSING_OR_INVALID naming DIALPAD_PII_HASH_SECRET when the PII hash secret is absent', async () => {
    const err = await tryRegister({ DIALPAD_WEBHOOK_SECRET: PRIMARY });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.code).toBe('CONFIG_MISSING_OR_INVALID');
    expect(err?.invalid).toEqual(['DIALPAD_PII_HASH_SECRET']);
    expect(err?.message).toContain('DIALPAD_PII_HASH_SECRET');
  });
});
