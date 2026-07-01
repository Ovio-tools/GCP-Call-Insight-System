# ADR 0001: Fastify + provider-agnostic OIDC/Redis-session shared hardening middleware

- Status: accepted
- Date: 2026-07-01
- Task: 2.3

## Context

Every HTTP surface (webhook receiver, status, review, knowledge-base, ServiceTitan) must be
protected identically, and CLAUDE.md §5 forbids any surface rolling its own hardening or auth.
No HTTP framework existed in the repo before this task, and no auth provider had been chosen.

## Decision

- **Framework: Fastify.** Its ordered hook lifecycle
  (`onRequest → preParsing → parsing → preHandler → handler`) maps directly onto the required
  ordering; raw body is preservable per-app for signature verification; and encapsulated
  plugins make bypass hard. Shared building blocks live in `src/http/`; surfaces consume the
  `createInternalApp` / `createWebhookApp` factories.
- **Auth: provider-agnostic OIDC + server-side Redis sessions.** An `AuthProvider` port with
  an OIDC/OAuth2 authorization-code + PKCE adapter (`openid-client`) configured by `OIDC_*`.
  Sessions are server-side (Redis in prod), rotated on login, CSRF-protected. The concrete
  identity provider (Google Workspace / Auth0 / Okta / WorkOS) is a config choice, not a code
  dependency.
- **Shared stores: Redis, with in-memory fakes for tests.** Rate-limit counters (atomic
  fixed-window via Lua), the reserve/commit replay store, and sessions are all Redis-backed so
  they are correct across the separate services; unit tests inject in-memory fakes and a
  controllable clock.

## Consequences

- Responses are a minimal, PII-free `{ error, message, request_id }`; full operational detail
  (from the Task 2.2 failure model) goes only to logs. Eight hardening/auth codes were added
  to the failure taxonomy (CLAUDE.md §4).
- Rate limiting is implemented over a small `RateStore` seam rather than `@fastify/rate-limit`,
  so the two tiers (per-IP and per-user) share one abstraction and are unit-testable with
  fakes.
- Webhook replay uses reserve/commit (not a one-shot insert) so a legitimate provider retry
  after a transient handler failure is still accepted.
- Consuming tasks (3.2, 6.2, 7.3, 10.1, 12.1) cannot bypass the protections: internal routes
  are auth-required by default, and webhooks can only be added through `registerWebhook`. See
  `docs/http-middleware.md`.
