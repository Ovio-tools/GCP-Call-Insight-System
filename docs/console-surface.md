# Console surface — single sign-in entry point

The **console surface** is one authenticated service that mounts every internal screen on a single
domain under a single login. It exists so a person signs in once and reaches everything from a home
page, instead of visiting a separate domain (and logging in again) per screen. Boot:
`node dist/services/console-surface.js` (`src/services/console-surface.ts`). Reuses `config.PORT`.

## What it mounts

| Path                       | Screen           | Served by                 |
| -------------------------- | ---------------- | ------------------------- |
| `GET /`                    | Home (links)     | `src/console/routes.ts`   |
| `GET /status` · `.json`    | Pipeline health  | `registerStatusRoutes`    |
| `GET /calls` · `.json`     | All-calls view   | `registerStatusRoutes`    |
| `GET /knowledge` + exports | Knowledge base   | `registerKnowledgeRoutes` |
| `GET /review` + actions    | Review queue     | `registerReviewRoutes`    |
| `GET /notes` + feedback    | Technician notes | `registerNotesRoutes`     |

The home page (`src/console/home-render.ts`) is self-contained HTML (inline CSS, one small inline
script for the CSRF'd logout, no external assets, no PII) — a card per screen, matching the dark
palette the other surfaces use.

The note-review surface is the one screen with **no single-surface service of its own**: it is
mounted only here, so `console-surface.ts` is its boot file and its routes are registered under the
`console` entry in `test/security/_registry.ts`. It adds no dependency to this service — it takes
the same four the knowledge surface does (`pool`, `config`, `denyTerms`, `logger`) and deliberately
takes neither the raw pool, the key provider, the restricted runner, nor the queue. Its five reads
and one CSRF'd write are detailed in [`docs/adr/0009-technician-notes-durable-and-feedback-append-only.md`](adr/0009-technician-notes-durable-and-feedback-append-only.md).

## Why it composes cleanly

All the surfaces build on the same `createInternalApp` factory, share one auth/session/CSRF/
rate-limit stack, and declare **fully disjoint** route paths; no route module registers a
decorator/plugin/hook. So registering them all plus the home route on one Fastify instance is
collision-free — Fastify would throw at registration on a duplicate route, and
`test/console/routes.test.ts` asserts the combined router carries every path. Signed-in users land
on `/` (the home); `loginSuccessRedirect` is `/` here (the single-surface entrypoints each land on
their own view because `/` has no route there).

## Environment

Because the console includes the **review** surface, it needs the review-only variables on top of
the shared internal-surface set. This is the UNION of what the three single-surface services need:

- **Shared internal-surface set:** `DATABASE_URL`, `REDIS_URL`, `RAW_DATABASE_URL` (readiness probes
  it for every internal surface), `SESSION_SECRET`, `SESSION_COOKIE_NAME`, `SESSION_COOKIE_SECURE`,
  `SESSION_TTL_MS`, the OIDC quartet `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` /
  `OIDC_REDIRECT_URI` (+ `OIDC_SCOPES`), `PORT`, `CORS_ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS`, the
  rate-limit vars, and `REDACTION_DENY_LIST_PATH` (knowledge + review + notes residual-egress guard).
  `NOTES_PAGE_SIZE_DEFAULT` / `NOTES_PAGE_SIZE_MAX` both have defaults, so the note-review screen
  adds no _required_ variable.
- **Review-only (the delta):** `REVIEW_ELEVATED_ROLE` (fail-closed reveal gate — unset means no one
  can reveal raw), `REVIEW_HELD_RAW_RETENTION_CAP_HOURS` (required, reveal retention window), and the
  crypto key-provider variables (`CRYPTO_KEY_PROVIDER` + its material — `CRYPTO_KEK_MATERIAL` /
  `CRYPTO_WRAPPED_DEK_MATERIAL` for the `railway` provider), because the review reveal decrypts raw
  transcripts + vault tokens from the isolated raw store (DB-B).

`OIDC_REDIRECT_URI` must point at **this** service's `/auth/callback`, and that exact URL must be in
the IdP's allowed-callbacks list (one console domain = one callback to register, versus one per
single-surface domain). The session cookie is host-scoped, which is exactly why one combined domain
gives one login for all screens.

## Relationship to the single-surface services

`status-surface` / `knowledge-surface` / `review-surface` remain valid for isolated deploys, but for
a combined experience deploy the console instead. See
[`docs/review-surface.md`](review-surface.md) for the review action model and reveal semantics.
