import Anthropic from '@anthropic-ai/sdk';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';
import type { Config } from '../config/schema.js';
import {
  CALL_INTENT,
  NOTE_COMMITMENTS_MADE_KEYS,
  NOTE_EQUIPMENT_KEYS,
  NOTE_OCCUPANCIES,
  NOTE_PAYER_AUTHORITY_KEYS,
  NOTE_PRIOR_WORK_KEYS,
  NOTE_SCOPE_SIGNALS,
  NOTE_SYSTEM_CONTEXT_KEYS,
  NOTE_WATER_STATUS_KEYS,
  SERVICE_CATEGORIES,
  SENTIMENTS,
  URGENCY,
} from '../db/enums.js';

/**
 * Anthropic classify-, extract-, and technician-note model client wrappers — the ONLY module
 * that imports `@anthropic-ai/sdk`. Each consumer takes an interface
 * ({@link ClassifyModelClient} / {@link ExtractModelClient} / {@link TechnicianNoteModelClient});
 * tests inject fakes.
 *
 * Model ID + structured-output support verified against Anthropic docs 2026-07-02
 * (`claude-haiku-4-5-20251001` is the valid full ID for Haiku 4.5, alias
 * `claude-haiku-4-5`; Haiku 4.5 supports `output_config.format` json_schema).
 *
 * Privacy: this module has NO logger dependency — it is structurally unable to
 * leak transcript content into logs. Thrown errors carry FIXED per-kind message
 * strings, never SDK error text (which could echo request/response content).
 *
 * `normalize()` and `toModelApiError()` below are SHARED by both the classify and
 * extract clients — there is exactly one implementation of each. Only the request
 * (model, max_tokens, output format) differs between the two.
 */

export type ModelErrorKind = 'auth' | 'rate_limited' | 'transient' | 'unexpected';

/**
 * Whether the failed attempt may have been billed by Anthropic.
 * `maybe_billed` ⇒ the caller keeps its cost reservation (spend may have happened);
 * `not_billed` ⇒ the request was rejected before inference (auth / rate limit).
 */
export type BillingDisposition = 'not_sent' | 'not_billed' | 'maybe_billed';

/** Fixed per-kind messages. Never include SDK error text or response bodies. */
const KIND_MESSAGES: Record<ModelErrorKind, string> = {
  auth: 'Anthropic API rejected the credentials (auth failure)',
  rate_limited: 'Anthropic API rate limit exceeded',
  transient: 'Anthropic API transient failure (server error or connection failure)',
  unexpected: 'Anthropic API call failed in an unexpected way',
};

export class ModelApiError extends Error {
  readonly kind: ModelErrorKind;
  readonly billingDisposition: BillingDisposition;
  readonly status?: number;

  constructor(kind: ModelErrorKind, billingDisposition: BillingDisposition, status?: number) {
    // message is a FIXED per-kind string — never SDK error text (could echo
    // request/response content and violate the privacy boundary).
    super(KIND_MESSAGES[kind]);
    this.name = 'ModelApiError';
    this.kind = kind;
    this.billingDisposition = billingDisposition;
    if (status !== undefined) this.status = status;
  }
}

/** The four classify buckets — the single source of truth for the wire schema. */
export const CLASSIFY_BUCKETS = ['customer', 'non-customer', 'spam', 'held'] as const;

/**
 * Structured-output format sent on every classify request.
 *
 * Hand-written json_schema constant (not the SDK's `zodOutputFormat` helper):
 * the repo pins zod ^3.23 and the helper is not adopted to avoid coupling the
 * wire schema to zod-version-specific JSON-schema generation. Task 5's parse
 * module defines the zod mirror; a cross-check test between the two schemas
 * lives there.
 *
 * The schema intentionally carries NO min/max length constraints — structured
 * outputs reject some constraint keywords; the zod layer (Task 5) enforces
 * reason length.
 */
export const CLASSIFY_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      bucket: { type: 'string', enum: CLASSIFY_BUCKETS },
      reason: { type: 'string' },
    },
    required: ['bucket', 'reason'],
    additionalProperties: false,
  },
} as const satisfies Anthropic.Messages.JSONOutputFormat;

/** JSON string form — Task 7 uses this for payload-size estimation. */
export const CLASSIFY_OUTPUT_FORMAT_JSON = JSON.stringify(CLASSIFY_OUTPUT_FORMAT);

export interface ClassifyModelResult {
  /** Concatenated text blocks (empty-string join — a JSON doc split across blocks stays parseable); null when none. */
  text: string | null;
  /** Passed through verbatim (may be null); stop-reason policy lives in parse.ts (Task 5). */
  stopReason: string | null;
  /** 0 when usage is missing from the response. */
  inputTokens: number;
  outputTokens: number;
  usagePresent: boolean;
}

export interface ClassifyModelClient {
  classify(req: { system: string; userText: string }): Promise<ClassifyModelResult>;
}

/**
 * Map an SDK-thrown error to a {@link ModelApiError}, most-specific-first.
 * TS SDK fact: `APIConnectionError` is a SUBCLASS of `APIError` — it must be
 * checked before the base class.
 */
function toModelApiError(error: unknown): ModelApiError {
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new ModelApiError('auth', 'not_billed', error.status);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelApiError('rate_limited', 'not_billed', error.status);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelApiError('transient', 'maybe_billed');
  }
  // Covers 500 and 529 (overloaded_error) — both InternalServerError in the TS SDK.
  if (error instanceof Anthropic.InternalServerError) {
    return new ModelApiError('transient', 'maybe_billed', error.status);
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new ModelApiError('unexpected', 'maybe_billed', status);
  }
  return new ModelApiError('unexpected', 'maybe_billed');
}

/** Received-but-broken response shapes are normalized (returned), never thrown. */
function normalize(response: Anthropic.Message): ClassifyModelResult {
  const content: unknown = (response as { content?: unknown }).content;
  const texts = (Array.isArray(content) ? content : [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text);

  const stopReason = (response as { stop_reason?: unknown }).stop_reason;
  const usage: unknown = (response as { usage?: unknown }).usage;
  const usageObj =
    typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : undefined;
  // A token count is only usable if it is a nonnegative safe integer. Anything else — absent,
  // null, NaN, fractional, a string, or an unsafe magnitude — is NOT trusted: `usagePresent`
  // then reports false so the handler holds the call and KEEPS the cost reservation, rather than
  // settling to a bogus (possibly 0) value and undercounting real spend (never-undercount).
  const tokenOf = (field: 'input_tokens' | 'output_tokens'): number | null => {
    const value = usageObj ? usageObj[field] : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const inputTokens = tokenOf('input_tokens');
  const outputTokens = tokenOf('output_tokens');
  const usagePresent = inputTokens !== null && outputTokens !== null;

  return {
    text: texts.length > 0 ? texts.join('') : null,
    stopReason: typeof stopReason === 'string' ? stopReason : null,
    inputTokens: usagePresent ? inputTokens : 0,
    outputTokens: usagePresent ? outputTokens : 0,
    usagePresent,
  };
}

export function createAnthropicClassifyClient(
  config: Config,
  options: { fetch?: typeof fetch } = {},
): ClassifyModelClient {
  // Fail fast with the shared config error shape, naming the missing variable
  // (mirrors src/dialpad/client/auth.ts).
  if (!config.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      ['ANTHROPIC_API_KEY'],
      `${CONFIG_ERROR_CODE}: ANTHROPIC_API_KEY is required to call the Anthropic API`,
    );
  }

  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    // maxRetries: 0 in production is DELIBERATE — SDK-internal retries would hide
    // a maybe-billed failed attempt + successful retry behind ONE cost reservation
    // and undercount spend. Retries belong to BullMQ, where each attempt
    // re-reserves against the daily cost cap.
    maxRetries: 0,
    timeout: config.ANTHROPIC_TIMEOUT_MS, // TS SDK timeout is in milliseconds
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async classify({ system, userText }): Promise<ClassifyModelResult> {
      let response: Anthropic.Message;
      try {
        // NO `thinking`, NO `effort`, NO temperature — Haiku 4.5 supports none
        // of those here.
        response = await client.messages.create({
          model: config.CLASSIFY_MODEL_ID,
          max_tokens: config.CLASSIFY_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: userText }],
          output_config: { format: CLASSIFY_OUTPUT_FORMAT },
        });
      } catch (error) {
        throw toModelApiError(error);
      }
      return normalize(response);
    },
  };
}

/**
 * Shared result shape for classify and extract: the response envelope (text /
 * stopReason / inputTokens / outputTokens / usagePresent) is identical for both
 * stages — only the request differs. Non-breaking alias: {@link ClassifyModelResult}
 * stays exported and unchanged.
 */
export type ModelTextResult = ClassifyModelResult;

/**
 * Structured-output format sent on every extract request — the 13-field extraction
 * record.
 *
 * Hand-written json_schema constant (same convention as {@link CLASSIFY_OUTPUT_FORMAT}):
 * the repo pins zod ^3.23 and the SDK's `zodOutputFormat` helper is not adopted, to avoid
 * coupling the wire schema to zod-version-specific JSON-schema generation. A later
 * milestone's zod layer owns length/shape constraints; this schema intentionally carries
 * NO min/max length or item-count keywords — structured outputs reject those keywords.
 *
 * Enum tuples are imported from `../db/enums.js` (the single source of truth for the
 * controlled vocabularies) rather than inlined as literals.
 *
 * `location_in_home`, `access_or_scheduling_notes`, `prior_attempts`, and
 * `acquisition_source` are nullable strings, expressed as `type: ['string', 'null']`. If
 * this array-type form is ever rejected by structured outputs, the fallback shape is
 * `anyOf: [{type: 'string'}, {type: 'null'}]` — a contract test pins the current form.
 *
 * `sentiment` is INTERNAL ONLY (never customer-facing, never exported — see
 * `db/enums.ts`). There is deliberately NO `confidence`/probability field anywhere in
 * this schema (three-layer no-confidence guarantee — this `additionalProperties: false`
 * structured-output schema is one layer; the other two live in later milestones).
 */
export const EXTRACT_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      call_intent: { type: 'string', enum: CALL_INTENT },
      service_category: { type: 'string', enum: SERVICE_CATEGORIES },
      problem_statement: { type: 'string' },
      symptoms: { type: 'array', items: { type: 'string' } },
      concerns: { type: 'array', items: { type: 'string' } },
      customer_language: { type: 'array', items: { type: 'string' } },
      competitor_mentions: { type: 'array', items: { type: 'string' } },
      location_in_home: { type: ['string', 'null'] },
      access_or_scheduling_notes: { type: ['string', 'null'] },
      prior_attempts: { type: ['string', 'null'] },
      acquisition_source: { type: ['string', 'null'] },
      urgency: { type: 'string', enum: URGENCY },
      sentiment: { type: 'string', enum: SENTIMENTS },
    },
    required: [
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
    ],
    additionalProperties: false,
  },
} as const satisfies Anthropic.Messages.JSONOutputFormat;

/** JSON string form — used for reservation/payload-size estimation. */
export const EXTRACT_OUTPUT_FORMAT_JSON = JSON.stringify(EXTRACT_OUTPUT_FORMAT);

export interface ExtractModelClient {
  extract(req: { system: string; userText: string }): Promise<ModelTextResult>;
}

export function createAnthropicExtractClient(
  config: Config,
  options: { fetch?: typeof fetch } = {},
): ExtractModelClient {
  // Fail fast with the shared config error shape, naming the missing variable
  // (mirrors createAnthropicClassifyClient above).
  if (!config.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      ['ANTHROPIC_API_KEY'],
      `${CONFIG_ERROR_CODE}: ANTHROPIC_API_KEY is required to call the Anthropic API`,
    );
  }

  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    // maxRetries: 0 in production is DELIBERATE — SDK-internal retries would hide
    // a maybe-billed failed attempt + successful retry behind ONE cost reservation
    // and undercount spend. Retries belong to BullMQ, where each attempt
    // re-reserves against the daily cost cap.
    maxRetries: 0,
    timeout: config.ANTHROPIC_TIMEOUT_MS, // TS SDK timeout is in milliseconds
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async extract({ system, userText }): Promise<ModelTextResult> {
      let response: Anthropic.Message;
      try {
        // NO `thinking`, NO `effort`, NO temperature — same request shape discipline
        // as the classify client.
        response = await client.messages.create({
          model: config.EXTRACT_MODEL_ID,
          max_tokens: config.EXTRACT_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: userText }],
          output_config: { format: EXTRACT_OUTPUT_FORMAT },
        });
      } catch (error) {
        throw toModelApiError(error);
      }
      return normalize(response);
    },
  };
}

/** A jsonb sub-object of the note: a fixed key set, every member nullable, nothing else. */
function noteGroup(
  keys: readonly string[],
  member: { readonly type: readonly string[] },
): {
  type: 'object';
  properties: Record<string, { readonly type: readonly string[] }>;
  required: readonly string[];
  additionalProperties: false;
} {
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, member])),
    required: keys,
    additionalProperties: false,
  };
}

const NULLABLE_STRING = { type: ['string', 'null'] } as const;
const NULLABLE_BOOLEAN = { type: ['boolean', 'null'] } as const;

/**
 * Structured-output format sent on every technician-note request (ADR 0009).
 *
 * Same conventions as {@link EXTRACT_OUTPUT_FORMAT}: hand-written json_schema,
 * `additionalProperties: false` at every level, enum tuples imported from `../db/enums.js`, and
 * NO min/max/length keywords anywhere — structured outputs reject them. That last point is why
 * the 800-character `dispatch_summary` cap lives in the zod layer instead, where an over-long
 * summary becomes a `schema_invalid` parse failure (and therefore a bounded retry) rather than a
 * silent truncation.
 *
 * Two deliberate omissions:
 * - `not_established` is NOT in this schema. That array is computed in code from a fixed
 *   REQUIRED_FOR_DISPATCH list after validation; letting the model write its own gap list would
 *   make it a self-assessment rather than a deterministic gate.
 * - No sentiment, tone, or characterization of the caller. Those live in `structured_knowledge`
 *   and are internal-only; the note is read by a technician standing in a driveway.
 *
 * As with extract there is deliberately NO confidence/probability field anywhere.
 */
export const TECHNICIAN_NOTE_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      scope_signal: { type: 'string', enum: NOTE_SCOPE_SIGNALS },
      occupancy: { type: 'string', enum: NOTE_OCCUPANCIES },
      equipment: noteGroup(NOTE_EQUIPMENT_KEYS, NULLABLE_STRING),
      system_context: noteGroup(NOTE_SYSTEM_CONTEXT_KEYS, NULLABLE_STRING),
      water_status: noteGroup(NOTE_WATER_STATUS_KEYS, NULLABLE_BOOLEAN),
      payer_authority: noteGroup(NOTE_PAYER_AUTHORITY_KEYS, NULLABLE_BOOLEAN),
      prior_work: noteGroup(NOTE_PRIOR_WORK_KEYS, NULLABLE_BOOLEAN),
      commitments_made: noteGroup(NOTE_COMMITMENTS_MADE_KEYS, NULLABLE_BOOLEAN),
      location_on_property: NULLABLE_STRING,
      symptom_verbatim: NULLABLE_STRING,
      prior_attempts_detail: NULLABLE_STRING,
      access_notes: NULLABLE_STRING,
      hazards: { type: 'array', items: { type: 'string' } },
      urgency_context: { type: 'array', items: { type: 'string' } },
      dispatch_summary: NULLABLE_STRING,
    },
    required: [
      'scope_signal',
      'occupancy',
      'equipment',
      'system_context',
      'water_status',
      'payer_authority',
      'prior_work',
      'commitments_made',
      'location_on_property',
      'symptom_verbatim',
      'prior_attempts_detail',
      'access_notes',
      'hazards',
      'urgency_context',
      'dispatch_summary',
    ],
    additionalProperties: false,
  },
} as const satisfies Anthropic.Messages.JSONOutputFormat;

/** JSON string form — used for reservation/payload-size estimation. */
export const TECHNICIAN_NOTE_OUTPUT_FORMAT_JSON = JSON.stringify(TECHNICIAN_NOTE_OUTPUT_FORMAT);

export interface TechnicianNoteModelClient {
  generate(req: { system: string; userText: string }): Promise<ModelTextResult>;
}

export function createAnthropicTechnicianNoteClient(
  config: Config,
  options: { fetch?: typeof fetch } = {},
): TechnicianNoteModelClient {
  // Fail fast with the shared config error shape, naming the missing variable.
  if (!config.ANTHROPIC_API_KEY) {
    throw new ConfigError(
      ['ANTHROPIC_API_KEY'],
      `${CONFIG_ERROR_CODE}: ANTHROPIC_API_KEY is required to call the Anthropic API`,
    );
  }

  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    // maxRetries: 0 for the same reason as the extract client — an SDK-internal retry would hide
    // a maybe-billed attempt behind one cost reservation. The note generator re-reserves per
    // attempt instead.
    maxRetries: 0,
    timeout: config.ANTHROPIC_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async generate({ system, userText }): Promise<ModelTextResult> {
      let response: Anthropic.Message;
      try {
        response = await client.messages.create({
          model: config.TECHNICIAN_NOTE_MODEL_ID,
          max_tokens: config.TECHNICIAN_NOTE_MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: userText }],
          output_config: { format: TECHNICIAN_NOTE_OUTPUT_FORMAT },
        });
      } catch (error) {
        throw toModelApiError(error);
      }
      return normalize(response);
    },
  };
}
