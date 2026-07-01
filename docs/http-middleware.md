# Shared HTTP hardening & auth middleware (Task 2.3)

Every HTTP surface in this system is built on the two app factories in `src/http/`, so no
surface rolls its own protections (CLAUDE.md §5). This note says what the toolkit provides
and what each consuming task still owns.

## What the toolkit provides

- **`createInternalApp(deps)`** — a Fastify instance for an authenticated internal surface.
  Auth is enforced **by default**: any route you add is protected unless it sets
  `config.public`. Lifecycle, in order:
  helmet → CORS (deny-by-default) → Tier-1 per-IP rate limit → session → `requireAuth`
  (attaches `request.user`) → Tier-2 per-user rate limit → `requireCsrf` → your handler →
  sanitized error handler. Body-size limit and JSON/malformed/media-type guards apply to all.
  It registers the `/auth/login`, `/auth/callback`, `/auth/csrf`, and `/auth/logout` routes.
- **`createWebhookApp(deps)`** — a Fastify instance plus `registerWebhook(opts)`. Raw body is
  preserved for signature checks. Every webhook you register is per-provider rate-limited and
  runs the chain signature → timestamp → replay-reserve → handler → commit/release. There is
  no way to add a webhook without that chain.
- **Failure-model integration** — every rejection is a stable failure code (see CLAUDE.md
  §4) rendered to a **minimal** response `{ error, message, request_id }`. Remediation,
  owner, runbook, context values, cookies, tokens, signatures, and stack traces never appear
  in a response or a log line.
- **Stores** — `RateStore` / `ReplayStore` (reserve/commit) / session store, with Redis
  implementations (`RedisRateStore`, `RedisReplayStore`, `RedisSessionStore`) for production
  and in-memory fakes for unit tests.
- **Auth** — a provider-agnostic `AuthProvider` port with an OIDC/PKCE adapter
  (`oidcProviderFromConfig`). Sessions are server-side, rotated on login, CSRF-protected.
- **Example routes** — `registerInternalExampleRoutes` and `registerWebhookExampleRoute` are
  the copy-paste reference (`src/http/example-routes.ts`).

Production wiring builds Redis clients with `createRedisClient(url)` and passes
`RedisRateStore` / `RedisReplayStore` / `RedisSessionStore`; tests pass the in-memory fakes.

## What each consuming task still owns

- **Task 3.2 (Dialpad webhook) & Task 12.1 (ServiceTitan webhook)** — the provider specifics
  passed to `registerWebhook`: `verifySignature` (built from `hmacSha256Hex` /
  `timingSafeEqualHex` or the provider's scheme), `extractEventId`, and `extractTimestamp`
  (all three are required, so replay/freshness can never be omitted), plus the handler that
  minimizes and stores the event. The toolkit owns wiring signature/replay/timestamp/rate
  limiting/hardening/errors. NB ServiceTitan auth is conditional (Task 12.0) — if HMAC is
  unavailable, supply the documented alternative `verifySignature`.
- **Task 6.2 (review), 7.3 (status), 10.1 (knowledge-base)** — their routes and any
  role checks off `request.user` (`{ id, roles }`). Mark only truly public routes (e.g. a
  health check) with `config.public`. Unsafe methods require the CSRF token
  (`getCsrfToken(request)` / `GET /auth/csrf`, sent back as `X-CSRF-Token`). The toolkit owns
  authentication, sessions, CSRF, hardening, and error shaping.

## Config

All settings live in `src/config/schema.ts` (mirrored in `.env.example`): `HTTP_MAX_BODY_BYTES`,
`CORS_ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS`, `RATE_LIMIT_*`, `USER_RATE_LIMIT_*`,
`WEBHOOK_RATE_LIMIT_*`, `WEBHOOK_REPLAY_WINDOW_MS`, `WEBHOOK_TIMESTAMP_SKEW_MS`, `SESSION_*`,
and `OIDC_*`. On Railway, set `TRUSTED_PROXY_HOPS` to the exact number of proxy hops (default

1. — never trust all hops, or clients could spoof `X-Forwarded-For`. Secure session cookies
   are required in staging/production and are refused otherwise.
