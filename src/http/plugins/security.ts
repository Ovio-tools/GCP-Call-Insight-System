import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

/**
 * Standard security headers and a deny-by-default CORS policy. A surface opts into CORS only
 * by configuring an explicit origin allowlist (`CORS_ALLOWED_ORIGINS`); with none set, no
 * cross-origin access is granted.
 */
export async function registerSecurity(
  app: FastifyInstance,
  corsOrigins: readonly string[],
): Promise<void> {
  await app.register(helmet);
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
