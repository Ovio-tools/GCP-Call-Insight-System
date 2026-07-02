import Anthropic from '@anthropic-ai/sdk';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';
import type { Config } from '../config/schema.js';

/**
 * Anthropic classify-model client wrapper — the ONLY module that imports
 * `@anthropic-ai/sdk`. The classify handler consumes the {@link ClassifyModelClient}
 * interface; tests inject fakes.
 *
 * Model ID + structured-output support verified against Anthropic docs 2026-07-02
 * (`claude-haiku-4-5-20251001` is the valid full ID for Haiku 4.5, alias
 * `claude-haiku-4-5`; Haiku 4.5 supports `output_config.format` json_schema).
 *
 * Privacy: this module has NO logger dependency — it is structurally unable to
 * leak transcript content into logs. Thrown errors carry FIXED per-kind message
 * strings, never SDK error text (which could echo request/response content).
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
