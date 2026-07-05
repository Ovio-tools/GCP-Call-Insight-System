import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { buildStatus } from './aggregate.js';
import { serializeStatus } from './serialize.js';
import { renderStatusPage } from './render.js';

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
  app.get('/status', async (_request, reply) => {
    const dto = await build();
    const html = renderStatusPage(dto, {
      refreshSeconds: deps.config.STATUS_PAGE_REFRESH_SECONDS,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // The same DTO as JSON.
  app.get('/status.json', async (_request, reply) => {
    const dto = await build();
    return reply.type('application/json; charset=utf-8').send(JSON.stringify(dto));
  });
}
