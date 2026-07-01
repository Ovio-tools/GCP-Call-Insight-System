import type { FastifyInstance } from 'fastify';
import type { WebhookApp } from './app.js';
import { getCsrfToken } from './plugins/auth.js';

/**
 * Reference routes exercised by the test suite and copied by consuming tasks. They show the
 * two supported shapes: an authenticated internal route reading `request.user`, and a signed
 * webhook wired through `registerWebhook`. No surface should hand-roll these protections.
 */

/** Add example internal routes to an app from `createInternalApp`. */
export function registerInternalExampleRoutes(app: FastifyInstance): void {
  // Public health check — the one exception to auth-by-default (opts out via config.public).
  app.get('/health', { config: { public: true } }, () => ({ status: 'ok' }));

  // Authenticated: echoes the identity the middleware attached. Never returns PII.
  app.get('/example/whoami', (request) => ({
    id: request.user?.id,
    roles: request.user?.roles ?? [],
    csrfToken: getCsrfToken(request) ?? null,
  }));

  // Authenticated + state-changing: requires a valid CSRF token (enforced by requireCsrf).
  app.post('/example/action', () => ({ ok: true }));
}

/**
 * Add an example webhook. `verifySignature`/`extractEventId`/`extractTimestamp` are the
 * provider-specific pieces a real integration (Task 3.2, 12.1) supplies; here they parse a
 * tiny JSON envelope over the raw body.
 */
export function registerWebhookExampleRoute(
  webhookApp: WebhookApp,
  opts: {
    verifySignature: import('./webhook/signature.js').SignatureVerifier;
    onEvent?: (eventId: string) => void;
  },
): void {
  webhookApp.registerWebhook({
    path: '/webhooks/example',
    provider: 'example',
    verifySignature: opts.verifySignature,
    extractEventId: (rawBody) => {
      const parsed = JSON.parse(rawBody.toString('utf8')) as { id?: unknown };
      if (typeof parsed.id !== 'string') {
        throw new Error('missing event id');
      }
      return parsed.id;
    },
    extractTimestamp: (rawBody) => {
      const parsed = JSON.parse(rawBody.toString('utf8')) as { ts?: unknown };
      return typeof parsed.ts === 'number' ? parsed.ts : Number.NaN;
    },
    handler: (request) => {
      const body = request.body as { id: string };
      opts.onEvent?.(body.id);
      return { received: true };
    },
  });
}
