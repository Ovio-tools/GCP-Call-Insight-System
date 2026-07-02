import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFY_BUCKETS,
  CLASSIFY_OUTPUT_FORMAT,
  CLASSIFY_OUTPUT_FORMAT_JSON,
  ModelApiError,
  createAnthropicClassifyClient,
} from '../../src/anthropic/client.js';
import { makeTestConfig } from '../_config.js';

/**
 * A marker planted in fake API error bodies. It must NEVER surface in a thrown
 * ModelApiError message — the wrapper uses fixed per-kind strings precisely so
 * SDK error text (which can echo request/response content) cannot leak.
 */
const BODY_MARKER = 'RESPONSE_BODY_MARKER_MUST_NOT_LEAK';

/** Config with an Anthropic key present; overrides on top of schema defaults. */
function cfg(overrides = {}) {
  return makeTestConfig({ ANTHROPIC_API_KEY: 'test-anthropic-key', ...overrides });
}

/** Build a client whose fetch returns the given queued responses in order (last repeats). */
function clientWith(responses: Array<Response | 'network'>, config = cfg()) {
  let i = 0;
  const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r === 'network') return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve(r as Response);
  });
  const client = createAnthropicClassifyClient(config, {
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** A well-formed Messages API success body; override fields to break shapes. */
function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text: '{"bucket":"customer","reason":"ok"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
    ...overrides,
  };
}

/** An Anthropic API error body carrying the leak marker. */
const apiError = (status: number, type: string): Response =>
  json({ type: 'error', error: { type, message: BODY_MARKER } }, { status });

const classifyReq = { system: 'You are a classifier.', userText: 'redacted transcript text' };

describe('createAnthropicClassifyClient — construction', () => {
  it('throws CONFIG_MISSING_OR_INVALID naming ANTHROPIC_API_KEY when the key is absent', () => {
    // makeTestConfig leaves optional-without-default vars (incl. ANTHROPIC_API_KEY) unset.
    const config = makeTestConfig();

    let thrown: unknown;
    try {
      createAnthropicClassifyClient(config);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'CONFIG_MISSING_OR_INVALID',
      invalid: ['ANTHROPIC_API_KEY'],
    });
    expect((thrown as Error).message).toContain('ANTHROPIC_API_KEY');
  });
});

describe('createAnthropicClassifyClient — single-attempt guarantee (maxRetries: 0)', () => {
  it('makes exactly ONE HTTP attempt on a 500; the queued success is never consumed', async () => {
    const { client, fetchImpl } = clientWith([apiError(500, 'api_error'), json(message())]);

    await expect(client.classify(classifyReq)).rejects.toMatchObject({
      name: 'ModelApiError',
      kind: 'transient',
      billingDisposition: 'maybe_billed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('makes exactly ONE HTTP attempt on a network rejection; no hidden retry', async () => {
    const { client, fetchImpl } = clientWith(['network', json(message())]);

    await expect(client.classify(classifyReq)).rejects.toMatchObject({
      kind: 'transient',
      billingDisposition: 'maybe_billed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createAnthropicClassifyClient — error mapping and billing disposition', () => {
  const cases: Array<{
    label: string;
    response: Response | 'network';
    kind: string;
    billing: string;
    status?: number;
  }> = [
    {
      label: '401 authentication',
      response: apiError(401, 'authentication_error'),
      kind: 'auth',
      billing: 'not_billed',
      status: 401,
    },
    {
      label: '403 permission',
      response: apiError(403, 'permission_error'),
      kind: 'auth',
      billing: 'not_billed',
      status: 403,
    },
    {
      label: '429 rate limit',
      response: apiError(429, 'rate_limit_error'),
      kind: 'rate_limited',
      billing: 'not_billed',
      status: 429,
    },
    {
      label: '500 server error',
      response: apiError(500, 'api_error'),
      kind: 'transient',
      billing: 'maybe_billed',
      status: 500,
    },
    {
      label: '529 overloaded',
      response: apiError(529, 'overloaded_error'),
      kind: 'transient',
      billing: 'maybe_billed',
      status: 529,
    },
    {
      label: 'network rejection',
      response: 'network',
      kind: 'transient',
      billing: 'maybe_billed',
    },
  ];

  for (const c of cases) {
    it(`maps ${c.label} → ${c.kind} / ${c.billing}`, async () => {
      const { client, fetchImpl } = clientWith([c.response]);

      let thrown: unknown;
      await client.classify(classifyReq).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ModelApiError);
      const err = thrown as ModelApiError;
      expect(err.kind).toBe(c.kind);
      expect(err.billingDisposition).toBe(c.billing);
      if (c.status !== undefined) expect(err.status).toBe(c.status);
      // Fixed per-kind message: response-body text must never leak into it.
      expect(err.message).not.toContain(BODY_MARKER);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  }

  it('maps an unknown thrown shape (unparseable 200 body) → unexpected / maybe_billed', async () => {
    const notJson = new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { client } = clientWith([notJson]);

    await expect(client.classify(classifyReq)).rejects.toMatchObject({
      name: 'ModelApiError',
      kind: 'unexpected',
      billingDisposition: 'maybe_billed',
    });
  });

  it('maps an unhandled HTTP status (400) → unexpected / maybe_billed, without body text', async () => {
    const { client } = clientWith([apiError(400, 'invalid_request_error')]);

    let thrown: unknown;
    await client.classify(classifyReq).catch((e: unknown) => {
      thrown = e;
    });

    expect(thrown).toBeInstanceOf(ModelApiError);
    const err = thrown as ModelApiError;
    expect(err.kind).toBe('unexpected');
    expect(err.billingDisposition).toBe('maybe_billed');
    expect(err.status).toBe(400);
    expect(err.message).not.toContain(BODY_MARKER);
  });
});

describe('createAnthropicClassifyClient — success and received-but-broken shapes', () => {
  it('returns text, stopReason, and token counts on a well-formed response', async () => {
    const { client } = clientWith([json(message())]);

    await expect(client.classify(classifyReq)).resolves.toEqual({
      text: '{"bucket":"customer","reason":"ok"}',
      stopReason: 'end_turn',
      inputTokens: 12,
      outputTokens: 7,
      usagePresent: true,
    });
  });

  it('returns usagePresent: false and zero tokens when usage is missing (never throws)', async () => {
    const { client } = clientWith([json(message({ usage: undefined }))]);

    await expect(client.classify(classifyReq)).resolves.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usagePresent: false,
    });
  });

  // A usage OBJECT whose token counts are absent or not usable integers must NOT be trusted:
  // treating it as present would let the handler settle the reservation to ~0 and undercount
  // real spend. Every one of these degrades to usagePresent: false + zero tokens (handler holds
  // malformed_model_output and KEEPS the reservation), never usagePresent: true.
  it.each([
    { label: 'empty usage object', usage: {} },
    { label: 'only input_tokens present', usage: { input_tokens: 5 } },
    { label: 'only output_tokens present', usage: { output_tokens: 7 } },
    { label: 'string token values', usage: { input_tokens: '12', output_tokens: '7' } },
    { label: 'fractional token values', usage: { input_tokens: 12.5, output_tokens: 7 } },
    { label: 'negative token value', usage: { input_tokens: -1, output_tokens: 7 } },
    { label: 'null token value', usage: { input_tokens: null, output_tokens: 7 } },
    { label: 'NaN token value', usage: { input_tokens: Number.NaN, output_tokens: 7 } },
  ])('treats $label as usagePresent: false with zero tokens', async ({ usage }) => {
    const { client } = clientWith([json(message({ usage }))]);

    await expect(client.classify(classifyReq)).resolves.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usagePresent: false,
    });
  });

  it('returns text: null for an empty content array', async () => {
    const { client } = clientWith([json(message({ content: [] }))]);
    await expect(client.classify(classifyReq)).resolves.toMatchObject({ text: null });
  });

  it('returns text: null when content has only non-text blocks', async () => {
    const { client } = clientWith([
      json(message({ content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] })),
    ]);
    await expect(client.classify(classifyReq)).resolves.toMatchObject({ text: null });
  });

  it('passes an unknown stop_reason value through verbatim', async () => {
    const { client } = clientWith([json(message({ stop_reason: 'brand_new_stop_reason' }))]);
    await expect(client.classify(classifyReq)).resolves.toMatchObject({
      stopReason: 'brand_new_stop_reason',
    });
  });

  it('returns stopReason: null when stop_reason is null', async () => {
    const { client } = clientWith([json(message({ stop_reason: null }))]);
    await expect(client.classify(classifyReq)).resolves.toMatchObject({ stopReason: null });
  });

  it('concatenates multiple text blocks (empty-string join)', async () => {
    const { client } = clientWith([
      json(
        message({
          content: [
            { type: 'text', text: '{"bucket":"spam",' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
            { type: 'text', text: '"reason":"split"}' },
          ],
        }),
      ),
    ]);
    await expect(client.classify(classifyReq)).resolves.toMatchObject({
      text: '{"bucket":"spam","reason":"split"}',
    });
  });
});

describe('createAnthropicClassifyClient — outgoing request contract', () => {
  it('sends the structured-output format, model, max_tokens, system, and user text', async () => {
    const config = cfg({
      CLASSIFY_MODEL_ID: 'claude-haiku-4-5-20251001',
      CLASSIFY_MAX_TOKENS: 256,
    });
    const { client, fetchImpl } = clientWith([json(message())], config);

    await client.classify(classifyReq);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: classifyReq.system,
      messages: [{ role: 'user', content: classifyReq.userText }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              bucket: { type: 'string', enum: ['customer', 'non-customer', 'spam', 'held'] },
              reason: { type: 'string' },
            },
            required: ['bucket', 'reason'],
            additionalProperties: false,
          },
        },
      },
    });

    // Haiku 4.5 supports none of these on this request — they must be absent.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('output_config.effort');
  });

  it('exports the bucket enum and a JSON string form of the format for payload sizing', () => {
    expect(CLASSIFY_BUCKETS).toEqual(['customer', 'non-customer', 'spam', 'held']);
    expect(CLASSIFY_OUTPUT_FORMAT_JSON).toBe(JSON.stringify(CLASSIFY_OUTPUT_FORMAT));
    expect(JSON.parse(CLASSIFY_OUTPUT_FORMAT_JSON)).toEqual(CLASSIFY_OUTPUT_FORMAT);
  });
});
