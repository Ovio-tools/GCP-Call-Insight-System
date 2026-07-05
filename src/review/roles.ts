import type { FastifyRequest } from 'fastify';
import type { Config } from '../config/schema.js';
import type { AuthenticatedUser } from '../http/auth/provider.js';
import { httpFailure } from '../http/failures.js';

/**
 * Whether a session is an ELEVATED reviewer (Task 6.2): its roles include the configured
 * `REVIEW_ELEVATED_ROLE`. Fail-closed — when the role is unset, NO session is elevated (elevated
 * raw/vault reveal is an explicit per-deployment opt-in). Any authenticated session is still a
 * base reviewer for list/detail and the seven actions; only the raw/vault reveal needs this.
 */
export function isElevatedReviewer(user: AuthenticatedUser | undefined, config: Config): boolean {
  const role = config.REVIEW_ELEVATED_ROLE;
  if (!role || !user) return false;
  return Array.isArray(user.roles) && user.roles.includes(role);
}

/**
 * Assert the request's session is an elevated reviewer, else throw `AUTH_FORBIDDEN` (403). The
 * failure carries only the environment — no roles, identifiers, or request content. Called by the
 * `/reveal-raw` route before any raw/vault read.
 */
export function requireElevatedReviewer(request: FastifyRequest, config: Config): void {
  if (!isElevatedReviewer(request.user, config)) {
    throw httpFailure('AUTH_FORBIDDEN', config.NODE_ENV);
  }
}
