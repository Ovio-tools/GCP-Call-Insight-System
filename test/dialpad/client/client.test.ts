import { describe, expect, it, vi } from 'vitest';
import { createDialpadClient } from '../../../src/dialpad/client/client.js';
import type { Limiter } from '../../../src/dialpad/client/limiter.js';
import { makeTestConfig } from '../../_config.js';

/** A limiter that never blocks — rate limiting is covered by limiter.test.ts. */
const passLimiter: Limiter = { acquire: () => Promise.resolve() };

/** Config with a key present and instant, deterministic backoff. */
function cfg(overrides = {}) {
  return makeTestConfig({
    DIALPAD_API_KEY: 'test-key',
    DIALPAD_BASE_URL: 'https://dialpad.test/api/v2',
    DIALPAD_API_MAX_RETRIES: 4,
    DIALPAD_API_BACKOFF_MS: 1,
    ...overrides,
  });
}

/** Build a client whose fetch returns the given queued responses in order (last repeats). */
function clientWith(
  responses: Array<Response | 'network'>,
  opts: { config?: ReturnType<typeof cfg> } = {},
) {
  const sleep = vi.fn((_ms: number) => Promise.resolve());
  let i = 0;
  const fetchImpl = vi.fn((_url: string) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r === 'network') return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve(r as Response);
  });
  const client = createDialpadClient({
    config: opts.config ?? cfg(),
    limiter: passLimiter,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    random: () => 0,
  });
  return { client, fetchImpl, sleep };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('DialpadClient.fetchTranscript', () => {
  it('returns a ready transcript (raw body) when lines have content', async () => {
    const body = { call_id: 'c-1', lines: [{ content: 'hello there' }] };
    const { client, fetchImpl } = clientWith([json(body)]);

    const result = await client.fetchTranscript('c-1');

    expect(result).toEqual({
      kind: 'ready',
      transcript: JSON.stringify(body),
      canonicalCallId: 'c-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The URL targets the transcripts endpoint for this call id.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://dialpad.test/api/v2/transcripts/c-1');
  });

  it('treats an explicit pending status as not-ready', async () => {
    const { client } = clientWith([json({ call_id: 'c-1', status: 'pending', lines: [] })]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('treats an empty transcript as not-ready', async () => {
    const { client } = clientWith([json({ call_id: 'c-1', lines: [] })]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('treats a 404 as not-ready (no crash)', async () => {
    const { client } = clientWith([new Response('', { status: 404 })]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('retries a 429 and then surfaces DIALPAD_RATE_LIMITED recommending a wait', async () => {
    const rl = () => new Response('', { status: 429 });
    const { client, fetchImpl, sleep } = clientWith([rl(), rl(), rl(), rl(), rl()]);

    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({
      name: 'DialpadError',
      kind: 'rate_limited',
      status: 429,
      attempts: 5, // 1 initial + DIALPAD_API_MAX_RETRIES (4)
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('honors Retry-After on a 429 before eventually succeeding', async () => {
    const { client, sleep } = clientWith([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      json({ lines: [{ content: 'ok now' }] }),
    ]);

    const result = await client.fetchTranscript('c-1');
    expect(result.kind).toBe('ready');
    expect(sleep).toHaveBeenCalledWith(2000); // 2s Retry-After honored (ms)
  });

  it('retries a 5xx then surfaces the transient (unavailable) class, NOT api_changed', async () => {
    const e = () => new Response('boom', { status: 503 });
    const { client, fetchImpl } = clientWith([e(), e(), e(), e(), e()]);

    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({
      name: 'DialpadError',
      kind: 'unavailable',
      attempts: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('retries a network error then surfaces unavailable', async () => {
    const { client, fetchImpl } = clientWith(['network']);
    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('fails fast on 401 auth with no retry', async () => {
    const { client, fetchImpl } = clientWith([new Response('', { status: 401 })]);
    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
      attempts: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps an unrecognized 200 shape to DIALPAD_API_CHANGED (never throws raw)', async () => {
    // Valid JSON, but none of the known transcript/not-ready fields → shape moved.
    const { client } = clientWith([json({ unexpected: true, foo: [1, 2, 3] })]);
    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({ kind: 'api_changed' });
  });

  it('treats a bare {call_id} envelope as not-ready (staging 2026-07: no-transcript calls)', async () => {
    // Dialpad returns 200 with ONLY a call_id for calls that never produced transcript
    // content. That is "no transcript available", not an API contract change.
    const { client } = clientWith([json({ call_id: 'c-1' })]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('tolerates explicit null transcript fields as not-ready (Dialpad null habit)', async () => {
    const { client } = clientWith([
      json({ call_id: 'c-1', lines: null, transcript: null, status: null, state: null }),
    ]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('maps non-JSON body to DIALPAD_API_CHANGED', async () => {
    const { client } = clientWith([new Response('<html>not json</html>', { status: 200 })]);
    await expect(client.fetchTranscript('c-1')).rejects.toMatchObject({ kind: 'api_changed' });
  });

  it('treats a confirmed empty transcript shape (lines: []) as not-ready, not a crash', async () => {
    const { client } = clientWith([json({ call_id: 'c-1', lines: [] })]);
    expect(await client.fetchTranscript('c-1')).toEqual({ kind: 'not_ready' });
  });

  it('succeeds on the first attempt without sleeping', async () => {
    const { client, sleep, fetchImpl } = clientWith([json({ lines: [{ content: 'x' }] })]);
    await client.fetchTranscript('c-1');
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchTranscript canonicalCallId', () => {
  it('returns the top-level call_id as a string when numeric', async () => {
    const body = { call_id: 6643403700510720, transcript: 'hello there' };
    const { client } = clientWith([json(body)]);

    const r = await client.fetchTranscript('4591131021746176');

    expect(r).toEqual({
      kind: 'ready',
      transcript: JSON.stringify(body),
      canonicalCallId: '6643403700510720',
    });
  });

  it('returns canonicalCallId verbatim when it is a string', async () => {
    const body = { call_id: '6643403700510720', transcript: 'hi' };
    const { client } = clientWith([json(body)]);

    const r = await client.fetchTranscript('4591131021746176');

    expect(r.kind === 'ready' && r.canonicalCallId).toBe('6643403700510720');
  });

  it('leaves canonicalCallId undefined when the field is absent', async () => {
    const body = { transcript: 'no id here' };
    const { client } = clientWith([json(body)]);

    const r = await client.fetchTranscript('4591131021746176');

    expect(r.kind === 'ready' && r.canonicalCallId).toBeUndefined();
  });
});

describe('DialpadClient.listRecentlyConcludedCalls', () => {
  it('parses metadata-only items and a pagination cursor', async () => {
    const body = {
      items: [
        { call_id: 111, state: 'hangup', direction: 'inbound', duration: 42 },
        { call_id: 'c-2', state: 'hangup' },
      ],
      cursor: 'next-page',
    };
    const { client, fetchImpl } = clientWith([json(body)]);

    const page = await client.listRecentlyConcludedCalls({ since: 1_700_000_000_000 });

    expect(page.cursor).toBe('next-page');
    expect(page.calls).toEqual([
      { callId: '111', state: 'hangup', direction: 'inbound', duration: 42 },
      { callId: 'c-2', state: 'hangup' },
    ]);
    // started_after is passed as the since epoch; no transcript endpoint is touched.
    // The real Dialpad Call-List endpoint is GET /api/v2/call (singular), not /calls.
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toMatch(/\/call\?/);
    expect(url).not.toContain('/calls?');
    expect(url).toContain('started_after=1700000000000');
    expect(url).not.toContain('/transcripts/');
  });

  it('parses date_ended (epoch ms or ISO string) into endedAt; omits it when unparseable', async () => {
    const body = {
      items: [
        { call_id: 'c-num', date_ended: 1_700_000_100_000 },
        { call_id: 'c-num-str', date_ended: '1700000200000' },
        { call_id: 'c-iso', date_ended: '2026-07-01T12:00:00.000Z' },
        { call_id: 'c-garbage', date_ended: 'not-a-date' },
        { call_id: 'c-ongoing' },
      ],
    };
    const { client } = clientWith([json(body)]);

    const page = await client.listRecentlyConcludedCalls({ since: 1000 });

    expect(page.calls).toEqual([
      { callId: 'c-num', endedAt: 1_700_000_100_000 },
      { callId: 'c-num-str', endedAt: 1_700_000_200_000 },
      { callId: 'c-iso', endedAt: Date.parse('2026-07-01T12:00:00.000Z') },
      // Unparseable and absent end timestamps yield NO endedAt — the sweep fails open.
      { callId: 'c-garbage' },
      { callId: 'c-ongoing' },
    ]);
  });

  it('passes a cursor through for pagination', async () => {
    const { client, fetchImpl } = clientWith([json({ items: [] })]);
    await client.listRecentlyConcludedCalls({ since: 1000, cursor: 'abc' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('cursor=abc');
  });

  it('accepts an empty page (items: [])', async () => {
    const { client } = clientWith([json({ items: [] })]);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.calls).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('treats items: null as an empty page (Dialpad returns null on a quiet window)', async () => {
    const { client } = clientWith([json({ items: null, cursor: null })]);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.calls).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('treats a fully absent items field as an empty page (nothing to miss)', async () => {
    const { client } = clientWith([json({})]);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.calls).toEqual([]);
  });

  it('maps an unexpected list shape to DIALPAD_API_CHANGED', async () => {
    const { client } = clientWith([json({ items: 'not-an-array' })]);
    await expect(client.listRecentlyConcludedCalls({ since: 1000 })).rejects.toMatchObject({
      kind: 'api_changed',
    });
  });

  it('rejects a body missing the required items collection (renamed/removed field)', async () => {
    // {} or a renamed field must NOT silently become an empty page — reconciliation would
    // otherwise miss every call.
    const { client } = clientWith([json({ calls: [{ call_id: 'c-1' }] })]);
    await expect(client.listRecentlyConcludedCalls({ since: 1000 })).rejects.toMatchObject({
      kind: 'api_changed',
    });
  });

  it('treats null-valued optional fields as absent (a missed/voicemail call)', async () => {
    // Real call APIs send explicit null for an unanswered call's duration/date_ended. That must
    // parse cleanly, not fail as api_changed (Zod .optional() rejects null; .nullish() accepts it).
    const body = {
      items: [
        { call_id: 999, state: 'missed', direction: 'inbound', duration: null, date_ended: null },
      ],
    };
    const { client } = clientWith([json(body)]);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.calls).toEqual([{ callId: '999', state: 'missed', direction: 'inbound' }]);
  });

  it('accepts a null cursor as "no more pages"', async () => {
    const { client } = clientWith([json({ items: [], cursor: null })]);
    const page = await client.listRecentlyConcludedCalls({ since: 1000 });
    expect(page.cursor).toBeUndefined();
  });

  it('carries a PII-free field path in the error detail when a field type is wrong', async () => {
    // A genuinely wrong type (string where a number is required) still fails — and the detail
    // names the field path + issue code (never the value) so the failure is diagnosable.
    const { client } = clientWith([
      json({ items: [{ call_id: 'c-1', duration: 'not-a-number' }] }),
    ]);
    const err = await client
      .listRecentlyConcludedCalls({ since: 1000 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'api_changed' });
    expect((err as { detail?: string }).detail).toContain('items.0.duration');
  });
});
