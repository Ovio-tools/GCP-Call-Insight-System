import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { RestrictedRunner } from '../db/restricted/restricted-context.js';
import { getCsrfToken, scriptNonce } from '../http/index.js';
import { httpFailure } from '../http/failures.js';
import type { ReprocessQueue } from '../queue/pipeline-queue.js';
import { buildReviewDetail, buildReviewList } from './queries.js';
import { renderReviewDetailPage, renderReviewListPage } from './render.js';
import { performReviewAction, type ReviewActionBody } from './actions.js';
import { performReveal } from './reveal.js';
import { requireElevatedReviewer, isElevatedReviewer } from './roles.js';
import { ReviewConflictError, ReviewNotFoundError } from './errors.js';
import {
  correctExtractionBodySchema,
  emptyBodySchema,
  reprocessBodySchema,
  reviewActionSchema,
  revealQuerySchema,
} from './request-dto.js';

/**
 * The authenticated review & admin surface routes (Task 6.2), mounted on a `createInternalApp`
 * app so auth is enforced by default (no route opts out with `config.public`). GET routes are
 * read-only HTML + JSON; POST routes are CSRF-enforced by the shared middleware. Every state
 * change goes through {@link performReviewAction} (one tx, idempotent, audited); the elevated
 * raw/vault reveal goes through {@link performReveal}.
 */
export interface ReviewRouteDeps {
  pool: Pool;
  /** Raw-store (DB-B) app pool for raw_transcripts reads (presence check + reveal). */
  rawPool: Pool;
  config: Config;
  logger: Logger;
  keyProvider: KeyProvider;
  /** Restricted runner on the raw store (DB-B) — the vault reveal's only restricted use. */
  runner: RestrictedRunner;
  queue: ReprocessQueue;
  denyTerms: readonly string[];
  /** Injected clock for deterministic tests. */
  now?: () => Date;
}

/** Map a domain error to its HTTP response; rethrow anything else for the shared error handler. */
function sendDomainError(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ReviewNotFoundError) {
    void reply
      .status(404)
      .send({ error: 'NOT_FOUND', message: 'Not found.', request_id: request.id });
    return;
  }
  if (err instanceof ReviewConflictError) {
    void reply.status(409).send({
      error: 'REVIEW_ACTION_CONFLICT',
      message: err.publicMessage,
      request_id: request.id,
    });
    return;
  }
  throw err;
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const nowFn = deps.now ?? ((): Date => new Date());
  const env = deps.config.NODE_ENV;

  // --- List ---
  app.get('/review.json', async (_request, reply) => {
    const list = await buildReviewList(deps.pool, nowFn());
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(list));
  });
  app.get('/review', async (request, reply) => {
    const list = await buildReviewList(deps.pool, nowFn());
    const html = renderReviewListPage(list, {
      csrfToken: getCsrfToken(request) ?? '',
      nonce: scriptNonce(reply),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // --- Detail ---
  const loadDetail = async (
    request: FastifyRequest,
  ): Promise<ReturnType<typeof buildReviewDetail>> => {
    const { id } = request.params as { id: string };
    return buildReviewDetail(deps.pool, deps.rawPool, deps.config, nowFn(), id, deps.denyTerms);
  };

  app.get('/review/:id.json', async (request, reply) => {
    const detail = await loadDetail(request);
    if (!detail) {
      return reply
        .status(404)
        .send({ error: 'NOT_FOUND', message: 'Not found.', request_id: request.id });
    }
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(detail));
  });
  app.get('/review/:id', async (request, reply) => {
    const detail = await loadDetail(request);
    if (!detail) {
      return reply
        .status(404)
        .send({ error: 'NOT_FOUND', message: 'Not found.', request_id: request.id });
    }
    const csrfToken = getCsrfToken(request) ?? '';
    const elevated = isElevatedReviewer(request.user, deps.config);
    const nonce = scriptNonce(reply);
    return reply
      .type('text/html; charset=utf-8')
      .send(renderReviewDetailPage(detail, { csrfToken, elevated, nonce }));
  });

  // --- Actions ---
  app.post('/review/:id/actions/:action', async (request, reply) => {
    const params = request.params as { id: string; action: string };
    const parsedAction = reviewActionSchema.safeParse(params.action);
    if (!parsedAction.success) throw httpFailure('REQUEST_MALFORMED', env);
    const action = parsedAction.data;

    let body: ReviewActionBody;
    if (action === 'reprocess') {
      const parsed = reprocessBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
      body = { kind: 'reprocess', stage: parsed.data.stage };
    } else if (action === 'correct_extraction') {
      const parsed = correctExtractionBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
      body = { kind: 'correct_extraction', enums: parsed.data };
    } else {
      const parsed = emptyBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw httpFailure('REQUEST_MALFORMED', env);
      body = { kind: 'empty' };
    }

    const actor = request.user?.id ?? '';
    if (!actor) throw httpFailure('AUTH_REQUIRED', env);

    try {
      const result = await performReviewAction({
        pool: deps.pool,
        rawPool: deps.rawPool,
        queue: deps.queue,
        config: deps.config,
        now: nowFn(),
        logger: deps.logger,
        reviewId: params.id,
        action,
        body,
        actor,
      });
      return reply.send({ status: result.outcome, action: result.action });
    } catch (err) {
      return sendDomainError(err, request, reply);
    }
  });

  // --- Elevated raw/vault reveal ---
  app.post('/review/:id/reveal-raw', async (request, reply) => {
    requireElevatedReviewer(request, deps.config);
    const { id } = request.params as { id: string };
    const parsedQuery = revealQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) throw httpFailure('REQUEST_MALFORMED', env);

    const actor = request.user?.id ?? '';
    if (!actor) throw httpFailure('AUTH_REQUIRED', env);

    try {
      const result = await performReveal({
        pool: deps.pool,
        rawPool: deps.rawPool,
        runner: deps.runner,
        keyProvider: deps.keyProvider,
        config: deps.config,
        now: nowFn(),
        logger: deps.logger,
        reviewId: id,
        ...(parsedQuery.data.token !== undefined ? { token: parsedQuery.data.token } : {}),
        actor,
      });
      return reply.send(result);
    } catch (err) {
      return sendDomainError(err, request, reply);
    }
  });
}
