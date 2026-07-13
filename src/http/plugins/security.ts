import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

/**
 * Per-request script nonce, keyed by the raw response object. The pages are server-rendered with
 * a small amount of INLINE JavaScript (the console logout button, the review action/reveal
 * submitter). Helmet's default `script-src 'self'` would block those, so we add a per-request
 * nonce to `script-src` and stamp it on each inline `<script>`. `style-src` keeps helmet's default
 * `'unsafe-inline'` (a nonce there would disable it and break every page's inline `<style>`), so
 * only scripts are nonce-gated. The nonce lives in a WeakMap rather than on the response object to
 * avoid mutating framework types; it is read back by `scriptNonce(reply)` in the handler.
 */
const scriptNonces = new WeakMap<object, string>();

/** The current request's script nonce, for a handler rendering an inline `<script nonce>`. */
export function scriptNonce(reply: FastifyReply): string {
  return scriptNonces.get(reply.raw) ?? '';
}

/**
 * Standard security headers and a deny-by-default CORS policy. A surface opts into CORS only
 * by configuring an explicit origin allowlist (`CORS_ALLOWED_ORIGINS`); with none set, no
 * cross-origin access is granted.
 */
export async function registerSecurity(
  app: FastifyInstance,
  corsOrigins: readonly string[],
): Promise<void> {
  // Generate the nonce first (before helmet's hook evaluates the CSP directive below).
  app.addHook('onRequest', (_request, reply, done) => {
    scriptNonces.set(reply.raw, randomBytes(16).toString('base64'));
    done();
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Keep `'self'` and add this request's nonce; all other directives stay at helmet defaults.
        scriptSrc: [
          "'self'",
          (_req: IncomingMessage, res: ServerResponse) =>
            `'nonce-${scriptNonces.get(res) ?? ''}'`,
        ],
      },
    },
  });
  await app.register(
    cors,
    corsOrigins.length > 0 ? { origin: [...corsOrigins] } : { origin: false },
  );
}

/** Parse the comma-separated CORS_ALLOWED_ORIGINS value into a trimmed, non-empty list. */
export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
