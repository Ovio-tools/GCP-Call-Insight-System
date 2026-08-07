import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFY_BUCKETS,
  CLASSIFY_OUTPUT_FORMAT,
  CLASSIFY_OUTPUT_FORMAT_JSON,
  EXTRACT_OUTPUT_FORMAT,
  EXTRACT_OUTPUT_FORMAT_JSON,
  ModelApiError,
  TECHNICIAN_NOTE_OUTPUT_FORMAT,
  TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON,
  createAnthropicClassifyClient,
  createAnthropicExtractClient,
} from '../../src/anthropic/client.js';
import {
  CALL_INTENT,
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_OCCUPANCIES,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SCOPE_SIGNALS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_TRISTATE,
  NOTE_WATER_STATUS_KEYS,
  SERVICE_CATEGORIES,
  URGENCY,
  SENTIMENTS,
} from '../../src/db/enums.js';
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

// --- Extract client (Task 5.2 M3) ---
// Mirrors the classify test pattern above; the extract client shares normalize() and
// toModelApiError() with the classify client, so error-mapping and malformed-usage
// coverage is not fully re-duplicated here (see the classify describe blocks above for
// the exhaustive per-status-code and per-malformed-usage matrices) — this section proves
// the extract client wires into the SAME shared logic, plus extract-specific request
// shape and schema pins.

/** Build an extract client whose fetch returns the given queued responses in order. */
function extractClientWith(responses: Array<Response | 'network'>, config = cfg()) {
  let i = 0;
  const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r === 'network') return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve(r as Response);
  });
  const client = createAnthropicExtractClient(config, {
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

const extractRecord = {
  call_intent: 'new_booking',
  service_category: 'water_heater',
  problem_statement: 'No hot water',
  symptoms: ['no hot water'],
  concerns: [],
  customer_language: ['no hot water at all'],
  competitor_mentions: [],
  location_in_home: 'basement',
  access_or_scheduling_notes: null,
  prior_attempts: null,
  acquisition_source: null,
  urgency: 'urgent',
  sentiment: 'neutral',
};

/** A well-formed Messages API success body for extract; override fields to break shapes. */
function extractMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: JSON.stringify(extractRecord) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 500, output_tokens: 120 },
    ...overrides,
  };
}

const extractReq = { system: 'You are an extractor.', userText: 'redacted transcript text' };

describe('createAnthropicExtractClient — construction', () => {
  it('throws CONFIG_MISSING_OR_INVALID naming ANTHROPIC_API_KEY when the key is absent', () => {
    const config = makeTestConfig();

    let thrown: unknown;
    try {
      createAnthropicExtractClient(config);
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

describe('createAnthropicExtractClient — outgoing request contract', () => {
  it('sends model, max_tokens, and the EXTRACT_OUTPUT_FORMAT structured-output format', async () => {
    const config = cfg({
      EXTRACT_MODEL_ID: 'claude-sonnet-4-6',
      EXTRACT_MAX_TOKENS: 4096,
    });
    const { client, fetchImpl } = extractClientWith([json(extractMessage())], config);

    await client.extract(extractReq);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.model).toBe(config.EXTRACT_MODEL_ID);
    expect(body.max_tokens).toBe(config.EXTRACT_MAX_TOKENS);
    expect(body.output_config).toEqual({ format: EXTRACT_OUTPUT_FORMAT });
  });

  it('sends EXACTLY system + userText — no other content added', async () => {
    const { client, fetchImpl } = extractClientWith([json(extractMessage())]);

    await client.extract(extractReq);

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.system).toBe(extractReq.system);
    expect(body.messages).toEqual([{ role: 'user', content: extractReq.userText }]);

    // No thinking/effort/temperature — same request-shape discipline as classify.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('output_config.effort');
  });
});

describe('createAnthropicExtractClient — shared error mapping (normalize/toModelApiError)', () => {
  const cases: Array<{
    label: string;
    response: Response | 'network';
    kind: string;
    billing: string;
  }> = [
    {
      label: '401 authentication',
      response: apiError(401, 'authentication_error'),
      kind: 'auth',
      billing: 'not_billed',
    },
    {
      label: '403 permission',
      response: apiError(403, 'permission_error'),
      kind: 'auth',
      billing: 'not_billed',
    },
    {
      label: '429 rate limit',
      response: apiError(429, 'rate_limit_error'),
      kind: 'rate_limited',
      billing: 'not_billed',
    },
    {
      label: '500 server error',
      response: apiError(500, 'api_error'),
      kind: 'transient',
      billing: 'maybe_billed',
    },
    {
      label: '529 overloaded',
      response: apiError(529, 'overloaded_error'),
      kind: 'transient',
      billing: 'maybe_billed',
    },
    { label: 'network rejection', response: 'network', kind: 'transient', billing: 'maybe_billed' },
  ];

  for (const c of cases) {
    it(`maps ${c.label} → ${c.kind} / ${c.billing}, never leaking the response body`, async () => {
      const { client } = extractClientWith([c.response]);

      let thrown: unknown;
      await client.extract(extractReq).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ModelApiError);
      const err = thrown as ModelApiError;
      expect(err.kind).toBe(c.kind);
      expect(err.billingDisposition).toBe(c.billing);
      expect(err.message).not.toContain(BODY_MARKER);
    });
  }

  // Guards the duplicated maxRetries: 0 construction in createAnthropicExtractClient: a
  // future edit could reintroduce hidden SDK retries on the extract path while classify's
  // own single-attempt test stays green. A queued success after a transient failure must
  // NEVER be consumed — exactly one HTTP attempt.
  it('makes exactly ONE HTTP attempt on a 500; the queued success is never consumed', async () => {
    const { client, fetchImpl } = extractClientWith([
      apiError(500, 'api_error'),
      json(extractMessage()),
    ]);

    await expect(client.extract(extractReq)).rejects.toMatchObject({
      name: 'ModelApiError',
      kind: 'transient',
      billingDisposition: 'maybe_billed',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createAnthropicExtractClient — success and usage handling', () => {
  it('returns text, stopReason, and token counts on a well-formed response', async () => {
    const { client } = extractClientWith([json(extractMessage())]);

    await expect(client.extract(extractReq)).resolves.toEqual({
      text: JSON.stringify(extractRecord),
      stopReason: 'end_turn',
      inputTokens: 500,
      outputTokens: 120,
      usagePresent: true,
    });
  });

  it('returns usagePresent: false and zero tokens when usage is missing from the response', async () => {
    const { client } = extractClientWith([json(extractMessage({ usage: undefined }))]);

    await expect(client.extract(extractReq)).resolves.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usagePresent: false,
    });
  });
});

describe('EXTRACT_OUTPUT_FORMAT — structural pins', () => {
  const EXPECTED_FIELDS = [
    'call_intent',
    'service_category',
    'problem_statement',
    'symptoms',
    'concerns',
    'customer_language',
    'competitor_mentions',
    'location_in_home',
    'access_or_scheduling_notes',
    'prior_attempts',
    'acquisition_source',
    'urgency',
    'sentiment',
  ];

  it('has exactly the 13 expected property keys', () => {
    expect(Object.keys(EXTRACT_OUTPUT_FORMAT.schema.properties)).toEqual(
      expect.arrayContaining(EXPECTED_FIELDS),
    );
    expect(Object.keys(EXTRACT_OUTPUT_FORMAT.schema.properties)).toHaveLength(
      EXPECTED_FIELDS.length,
    );
  });

  it('marks all 13 fields as required', () => {
    expect([...EXTRACT_OUTPUT_FORMAT.schema.required].sort()).toEqual([...EXPECTED_FIELDS].sort());
  });

  it('sets additionalProperties: false', () => {
    expect(EXTRACT_OUTPUT_FORMAT.schema.additionalProperties).toBe(false);
  });

  it('serialized form contains no length/item-count keywords or a confidence field', () => {
    const forbidden = ['minLength', 'maxLength', 'minItems', 'maxItems', 'confidence'];
    for (const term of forbidden) {
      expect(EXTRACT_OUTPUT_FORMAT_JSON).not.toContain(term);
    }
  });

  // Pins the nullable WIRE shape: without this a silent change of the four nullable fields
  // to plain {type:'string'} would keep every other structural pin green — contradicting
  // the client.ts comment that a contract test pins the current type-array form.
  it('pins the four nullable fields to the { type: ["string", "null"] } wire shape', () => {
    const nullableFields = [
      'location_in_home',
      'access_or_scheduling_notes',
      'prior_attempts',
      'acquisition_source',
    ] as const;
    for (const field of nullableFields) {
      expect(EXTRACT_OUTPUT_FORMAT.schema.properties[field].type).toEqual(['string', 'null']);
    }
  });

  it('mirrors the imported enum tuples exactly', () => {
    expect(EXTRACT_OUTPUT_FORMAT.schema.properties.call_intent.enum).toEqual(CALL_INTENT);
    expect(EXTRACT_OUTPUT_FORMAT.schema.properties.service_category.enum).toEqual(
      SERVICE_CATEGORIES,
    );
    expect(EXTRACT_OUTPUT_FORMAT.schema.properties.urgency.enum).toEqual(URGENCY);
    expect(EXTRACT_OUTPUT_FORMAT.schema.properties.sentiment.enum).toEqual(SENTIMENTS);
  });

  it('exports a JSON string form that round-trips to the same object', () => {
    expect(EXTRACT_OUTPUT_FORMAT_JSON).toBe(JSON.stringify(EXTRACT_OUTPUT_FORMAT));
    expect(JSON.parse(EXTRACT_OUTPUT_FORMAT_JSON)).toEqual(EXTRACT_OUTPUT_FORMAT);
  });
});

describe('TECHNICIAN_NOTE_OUTPUT_FORMAT — structural pins', () => {
  const GROUPS = {
    equipment: NOTE_EQUIPMENT_KEYS,
    system_context: NOTE_SYSTEM_CONTEXT_KEYS,
    water_status: NOTE_WATER_STATUS_KEYS,
    payer_authority: NOTE_PAYER_AUTHORITY_KEYS,
    prior_work: NOTE_PRIOR_WORK_KEYS,
    commitments_made: NOTE_COMMITMENTS_MADE_KEYS,
  } as const;

  const schema = TECHNICIAN_NOTE_OUTPUT_FORMAT.schema;

  /** One member of a jsonb group, widened for inspection (the const shape differs per group). */
  function memberOf(group: keyof typeof GROUPS, key: string): { type?: unknown; enum?: unknown } {
    const properties: Record<string, { type?: unknown; enum?: unknown }> =
      schema.properties[group].properties;
    const member = properties[key];
    if (member === undefined) throw new Error(`${group}.${key} is missing from the wire schema`);
    return member;
  }

  it('requires every property and allows no others, at the top level and in every group', () => {
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
    for (const [name, keys] of Object.entries(GROUPS)) {
      const group = schema.properties[name as keyof typeof GROUPS];
      expect(Object.keys(group.properties), name).toEqual([...keys]);
      expect([...group.required], name).toEqual([...keys]);
      expect(group.additionalProperties, name).toBe(false);
    }
  });

  /**
   * The whole point of the sentinel encoding: not one union-typed parameter anywhere. The
   * union-count gate in output-format-wire-limits.test.ts enforces the API's ceiling of 16; this
   * pins the note schema at the stricter target it was rewritten to hit, so re-introducing a
   * single nullable field here fails immediately rather than eating the shared headroom silently.
   */
  it('carries no nullable field at all — unset is a value, not a union', () => {
    expect(JSON.stringify(schema)).not.toContain('null');
    for (const [name, keys] of Object.entries(GROUPS)) {
      for (const key of keys) {
        expect(typeof memberOf(name as keyof typeof GROUPS, key).type, `${name}.${key}`).toBe(
          'string',
        );
      }
    }
  });

  it('gives every flag group the yes/no/unknown vocabulary and every text field a bare string', () => {
    for (const name of [
      'water_status',
      'payer_authority',
      'prior_work',
      'commitments_made',
    ] as const) {
      for (const key of GROUPS[name]) {
        expect(memberOf(name, key), `${name}.${key}`).toEqual({
          type: 'string',
          enum: NOTE_TRISTATE,
        });
      }
    }
    for (const name of ['equipment', 'system_context'] as const) {
      for (const key of GROUPS[name]) {
        expect(memberOf(name, key), `${name}.${key}`).toEqual({ type: 'string' });
      }
    }
    for (const field of [
      'location_on_property',
      'symptom_verbatim',
      'prior_attempts_detail',
      'access_notes',
      'dispatch_summary',
    ] as const) {
      expect(schema.properties[field], field).toEqual({ type: 'string' });
    }
  });

  it('mirrors the imported enum tuples and never offers not_established', () => {
    expect(schema.properties.scope_signal.enum).toEqual(NOTE_SCOPE_SIGNALS);
    expect(schema.properties.occupancy.enum).toEqual(NOTE_OCCUPANCIES);
    expect(Object.keys(schema.properties)).not.toContain('not_established');
  });

  it('exports a JSON string form that round-trips to the same object', () => {
    expect(TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON).toBe(JSON.stringify(TECHNICIAN_NOTE_OUTPUT_FORMAT));
    expect(JSON.parse(TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON)).toEqual(TECHNICIAN_NOTE_OUTPUT_FORMAT);
  });
});
