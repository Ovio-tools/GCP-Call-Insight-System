import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { getCsrfToken, scriptNonce } from '../http/index.js';
import { buildStatus } from './aggregate.js';
import { serializeStatus } from './serialize.js';
import { renderStatusPage } from './render.js';
import { listCalls } from './calls.js';
import { renderCallsPage } from './calls-render.js';

/**
 * The authenticated status surface routes (Task 7.3, plan §5). Mounted on an app from
 * `createInternalApp`, so auth is enforced by default — neither route opts out with
 * `config.public`, and an unauthenticated request is rejected 401 by the shared middleware.
 * GET-only (no CSRF concern). Both endpoints serialize the SAME DTO through
 * {@link serializeStatus} (the content-field guard, plan §4) before it leaves the process.
 */
export interface StatusRouteDeps {
  pool: Pool;
  config: Config;
  logger: Logger;
  /** Injected clock for deterministic tests. Defaults to the wall clock. */
  now?: () => Date;
}

export function registerStatusRoutes(app: FastifyInstance, deps: StatusRouteDeps): void {
  const nowFn = deps.now ?? ((): Date => new Date());

  const build = async (): ReturnType<typeof buildStatus> =>
    serializeStatus(
      await buildStatus(deps.pool, { config: deps.config, now: nowFn(), logger: deps.logger }),
    );

  // Server-rendered HTML page.
  app.get('/status', async (request, reply) => {
    const dto = await build();
    const html = renderStatusPage(dto, {
      refreshSeconds: deps.config.STATUS_PAGE_REFRESH_SECONDS,
      csrfToken: getCsrfToken(request) ?? '',
      nonce: scriptNonce(reply),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // The same DTO as JSON.
  app.get('/status.json', async (_request, reply) => {
    const dto = await build();
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });

  // Per-call pipeline view: every call and its outcome (customer/non-customer/spam/filtered/held/
  // processing), filterable + paginated. De-identified by construction (see calls.ts).
  const parsePage = (raw: unknown): number => {
    const n = Number.parseInt(typeof raw === 'string' ? raw : '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const buildCalls = (query: unknown): ReturnType<typeof listCalls> => {
    const q = (query ?? {}) as { outcome?: string; page?: string };
    const opts: { filter?: string; page: number } = { page: parsePage(q.page) };
    if (typeof q.outcome === 'string') opts.filter = q.outcome;
    return listCalls(deps.pool, opts);
  };

  app.get('/calls', async (request, reply) => {
    const dto = await buildCalls(request.query);
    const html = renderCallsPage(dto, {
      csrfToken: getCsrfToken(request) ?? '',
      nonce: scriptNonce(reply),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/calls.json', async (request, reply) => {
    const dto = await buildCalls(request.query);
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });
}
