import type { FastifyInstance } from 'fastify';
import { getCsrfToken, scriptNonce } from '../http/index.js';
import { renderHome } from './home-render.js';

/**
 * The combined-console home route: `GET /`, the single entry point that links to every internal
 * surface. Auth-by-default applies (the global `requireAuth` hook bounces an unauthenticated
 * browser navigation to login), so this route needs no extra guard. The per-session CSRF token is
 * embedded so the home page's logout button can set the `X-CSRF-Token` header.
 */
export function registerConsoleHomeRoute(app: FastifyInstance): void {
  app.get('/', (request, reply) => {
    const csrfToken = getCsrfToken(request) ?? '';
    const nonce = scriptNonce(reply);
    return reply.type('text/html; charset=utf-8').send(renderHome({ csrfToken, nonce }));
  });
}
