import 'fastify';
import '@fastify/session';
import type { AuthenticatedUser } from './auth/provider.js';

/**
 * Fastify type augmentation: the identity/role seam downstream handlers read, the route
 * opt-out flag, and the session fields the auth plugin manages.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth` on authenticated internal requests. */
    user?: AuthenticatedUser;
  }

  interface FastifyContextConfig {
    /** Mark a route reachable without authentication (health checks, the auth routes). */
    public?: boolean;
  }
}

declare module 'fastify' {
  // `@fastify/session` merges its session data into fastify's `Session` interface; extend it.
  interface Session {
    user?: AuthenticatedUser;
    /** Double-submit CSRF token issued after login. */
    csrfToken?: string;
    /** In-flight OIDC login state, cleared once the callback completes. */
    oidc?: {
      state: string;
      nonce: string;
      codeVerifier: string;
      returnTo?: string;
    };
  }
}
