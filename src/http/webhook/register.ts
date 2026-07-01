import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { createFailure, type ErrorCode, type FailureError } from '../../failure-model/index.js';
import type { Clock, RateStore, ReplayStore } from '../stores/types.js';
import { isTimestampFresh } from './timestamp.js';
import type { SignatureVerifier } from './signature.js';

/** Everything the webhook chain needs, bound once by `createWebhookApp`. */
export interface WebhookDeps {
  replayStore: ReplayStore;
  rateStore: RateStore;
  clock: Clock;
  /** The NODE_ENV value, stamped into failure context (never PII). */
  environment: string;
  replayWindowMs: number;
  timestampSkewMs: number;
  rateLimit: { max: number; windowMs: number };
}

/** A single webhook route: how to verify it and what to do once it is trusted. */
export interface WebhookRouteOptions {
  path: string;
  /** Provider name; part of the replay key and the rate-limit key. */
  provider: string;
  /** Verify authenticity over the raw body + headers. */
  verifySignature: SignatureVerifier;
  /** The provider's unique event id, used as the replay key. */
  extractEventId: (rawBody: Buffer, headers: IncomingHttpHeaders) => string;
  /** The event's timestamp in epoch milliseconds, for the freshness check. */
  extractTimestamp: (rawBody: Buffer, headers: IncomingHttpHeaders) => number;
  /** Runs only after signature, timestamp, and replay all pass. */
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

function webhookFailure(code: ErrorCode, deps: WebhookDeps): FailureError {
  return createFailure(code, {
    processingState: 'continuing',
    context: { component: 'webhook-receiver', environment: deps.environment },
  });
}

/** The raw request bytes preserved by fastify-raw-body (Buffer mode). */
function rawBodyOf(request: FastifyRequest): Buffer {
  const raw = request.rawBody;
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
}

/** Per-provider + per-IP rate limiter, run before the body is read. */
function webhookRateLimiter(deps: WebhookDeps, provider: string): onRequestHookHandler {
  return (request, _reply, done) => {
    const key = `webhook:${provider}:${request.ip}`;
    deps.rateStore
      .incr(key, deps.rateLimit.windowMs)
      .then((count) =>
        done(count > deps.rateLimit.max ? webhookFailure('RATE_LIMIT_EXCEEDED', deps) : undefined),
      )
      .catch((err: unknown) => done(err as Error));
  };
}

/**
 * Register a signed webhook. The verification chain — signature → timestamp → replay
 * reserve → handler → commit/release — is wired here and cannot be bypassed: there is no way
 * to add a webhook route through this helper without it. No side effect runs before the
 * signature and timestamp pass; the replay entry is only committed once the handler succeeds,
 * so a legitimate provider retry after a transient handler failure is still accepted.
 */
export function registerWebhook(
  app: FastifyInstance,
  deps: WebhookDeps,
  opts: WebhookRouteOptions,
): void {
  app.post(
    opts.path,
    { config: { public: true }, onRequest: webhookRateLimiter(deps, opts.provider) },
    async (request, reply) => {
      const rawBody = rawBodyOf(request);

      // 1. Signature — the first gate, before any side effect.
      const signatureValid = await opts.verifySignature(rawBody, request.headers);
      if (!signatureValid) {
        throw webhookFailure('WEBHOOK_SIGNATURE_INVALID', deps);
      }

      // 2. Freshness — reject stale/future (or unparseable) timestamps.
      let timestampMs: number;
      try {
        timestampMs = opts.extractTimestamp(rawBody, request.headers);
      } catch {
        throw webhookFailure('WEBHOOK_TIMESTAMP_INVALID', deps);
      }
      if (!isTimestampFresh(timestampMs, deps.clock.now(), deps.timestampSkewMs)) {
        throw webhookFailure('WEBHOOK_TIMESTAMP_INVALID', deps);
      }

      // 3. Replay reserve — only after the request is proven authentic and fresh.
      let eventId: string;
      try {
        eventId = opts.extractEventId(rawBody, request.headers);
      } catch {
        throw webhookFailure('REQUEST_MALFORMED', deps);
      }
      if (!eventId) {
        throw webhookFailure('REQUEST_MALFORMED', deps);
      }
      const reservation = await deps.replayStore.reserve(
        `${opts.provider}:${eventId}`,
        deps.replayWindowMs,
      );
      if (!reservation.acquired) {
        throw webhookFailure('WEBHOOK_REPLAY_DETECTED', deps);
      }

      // 4. The only side effect. Release ONLY when the handler itself failed, so a
      //    legitimate retry is accepted. If the handler succeeded but commit() failed, keep
      //    the reservation in place (it blocks retries until its TTL) so the handler's
      //    already-applied side effects are never repeated.
      let handlerSucceeded = false;
      try {
        const result = await opts.handler(request, reply);
        handlerSucceeded = true;
        await reservation.commit();
        return result;
      } catch (err) {
        if (!handlerSucceeded) {
          await reservation.release();
        }
        throw err;
      }
    },
  );
}
