import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../../config/schema.js';
import { createFailure } from '../../failure-model/index.js';
import { createCallLogger, logger as defaultLogger } from '../../logging/logger.js';
import { systemClock, type Clock, type WebhookApp } from '../../http/index.js';
import { verifyAndDecodeDialpadJwt, type DialpadSecrets } from './jwt.js';
import { hashPii } from './hash.js';
import {
  extractCallId,
  parseClaims,
  replayKeyFor,
  toAuditPayload,
  toCallStateMetadata,
} from './payload.js';
import type { DialpadIngestSink } from './sink.js';

/** The public webhook path Dialpad is configured to POST to. */
export const DIALPAD_WEBHOOK_PATH = '/webhooks/dialpad';
const PROVIDER = 'dialpad';

export interface DialpadWebhookDeps {
  config: Config;
  /** The side effect (call_state upsert + audit row + enqueue), behind a port for testability. */
  sink: DialpadIngestSink;
  logger?: Logger;
  /** Time source shared with freshness/replay so the retention stamp is deterministic in tests. */
  clock?: Clock;
}

/**
 * Accept ANY content-type as a raw Buffer, so a bare-JWT body is never rejected as malformed JSON
 * by Fastify's built-in parser. `removeAllContentTypeParsers` drops the default json/text parsers
 * (a fallback `*` parser alone would NOT override the built-in `application/json` one); the
 * body-size limit still applies, so oversized bodies still surface as REQUEST_BODY_TOO_LARGE. The
 * SERVICE calls this exactly once, before registering the route — the single owner of the parser.
 */
export function installDialpadBodyParser(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
}

/** The exact request bytes preserved by fastify-raw-body (Buffer mode). */
function rawBodyOf(request: FastifyRequest): Buffer {
  const raw = (request as FastifyRequest & { rawBody?: Buffer | string }).rawBody;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
}

function configFailure(config: Config): never {
  throw createFailure('CONFIG_MISSING_OR_INVALID', {
    processingState: 'paused',
    context: { environment: config.NODE_ENV, component: 'webhook-receiver' },
  });
}

/**
 * Register the Dialpad webhook on top of the shared hardening middleware (Task 2.3). The generic
 * protections — body limit, rate limit, replay, timestamp skew, PII-free errors — are wired by
 * `registerWebhook`; this adds the Dialpad specifics: HS256 JWT verification (alg pinned, primary
 * + optional previous secret), the replay key, the minimized/allowlisted write, and one enqueue.
 *
 * Both secrets are REQUIRED in every environment: without the signing secret nothing can be
 * authenticated; without the PII hash secret there could be a plaintext-phone/name path. Missing
 * either throws CONFIG_MISSING_OR_INVALID at registration.
 */
export function registerDialpadWebhook(webhookApp: WebhookApp, deps: DialpadWebhookDeps): void {
  const { config, sink } = deps;
  const logger = deps.logger ?? defaultLogger;
  const clock = deps.clock ?? systemClock;

  const primary = config.DIALPAD_WEBHOOK_SECRET;
  const hashSecret = config.DIALPAD_PII_HASH_SECRET;
  if (!primary || !hashSecret) {
    configFailure(config);
  }
  const secrets: DialpadSecrets = {
    primary,
    ...(config.DIALPAD_WEBHOOK_SECRET_PREVIOUS
      ? { previous: config.DIALPAD_WEBHOOK_SECRET_PREVIOUS }
      : {}),
  };

  webhookApp.registerWebhook({
    path: DIALPAD_WEBHOOK_PATH,
    provider: PROVIDER,

    // 1. Authenticity: HS256 over the whole JWT body. Constant-time compare lives in the verifier.
    verifySignature: (rawBody: Buffer): boolean =>
      verifyAndDecodeDialpadJwt(rawBody, secrets) !== null,

    // 2. Freshness: Dialpad signs `iat` (seconds). Required mode — the contract confirms a signed
    //    timestamp. If a real payload ever lacks it, omit this to register in unsupported mode.
    extractTimestamp: (rawBody: Buffer): number => {
      const result = verifyAndDecodeDialpadJwt(rawBody, secrets);
      if (!result) return Number.NaN;
      const claims = parseClaims(result.claims);
      return typeof claims.iat === 'number' ? claims.iat * 1000 : Number.NaN;
    },

    // 3. Replay key: unique event id if present, else a digest of the signed payload (+iat).
    extractEventId: (rawBody: Buffer): string => {
      const result = verifyAndDecodeDialpadJwt(rawBody, secrets);
      if (!result) throw new Error('unverifiable event'); // → REQUEST_MALFORMED
      return replayKeyFor(result);
    },

    // 4. The only side effect. Minimizes to an allowlist, seeds call_state, writes the audit row,
    //    enqueues exactly one ingest job keyed by call_id. No transcript fetch / model / heavy work.
    handler: async (request): Promise<{ received: true }> => {
      const result = verifyAndDecodeDialpadJwt(rawBodyOf(request), secrets);
      if (!result) {
        // Unreachable in practice (signature already verified); fail closed if it ever is.
        throw createFailure('REQUEST_MALFORMED', {
          processingState: 'continuing',
          context: { environment: config.NODE_ENV, component: 'webhook-receiver' },
        });
      }
      const callId = extractCallId(parseClaims(result.claims));
      if (!callId) {
        throw createFailure('REQUEST_MALFORMED', {
          processingState: 'continuing',
          context: { environment: config.NODE_ENV, component: 'webhook-receiver' },
        });
      }

      const receivedAt = new Date(clock.now());
      await sink.ingest({
        callId,
        sourceMetadata: toCallStateMetadata(result.claims),
        auditPayload: toAuditPayload(result, (value) => hashPii(value, hashSecret)),
        receivedAt,
        retentionEligibleAt: receivedAt,
      });

      // Safe observability: which signing secret matched (for rotation), stamped with call_id.
      // Logged AFTER call_id is validated. No PII — the redaction guard would throw otherwise.
      createCallLogger(callId, logger).info(
        { component: 'webhook-receiver', webhook_key_slot: result.secretSlot },
        'dialpad webhook ingested',
      );

      return { received: true };
    },
  });
}
