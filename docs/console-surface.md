# Console surface — single sign-in entry point

The **console surface** is one authenticated service that mounts every internal screen on a single
domain under a single login. It exists so a person signs in once and reaches everything from a home
page, instead of visiting a separate domain (and logging in again) per screen. Boot:
`node dist/services/console-surface.js` (`src/services/console-surface.ts`). Reuses `config.PORT`.

## What it mounts

| Path                       | Screen          | Served by                 |
| -------------------------- | --------------- | ------------------------- |
| `GET /`                    | Home (links)    | `src/console/routes.ts`   |
| `GET /status` · `.json`    | Pipeline health | `registerStatusRoutes`    |
| `GET /calls` · `.json`     | All-calls view  | `registerStatusRoutes`    |
| `GET /knowledge` + exports | Knowledge base  | `registerKnowledgeRoutes` |
| `GET /review` + actions    | Review queue    | `registerReviewRoutes`    |

The home page (`src/console/home-render.ts`) is self-contained HTML (inline CSS, one small inline
script for the CSRF'd logout, no external assets, no PII) — a card per screen, matching the dark
palette the other surfaces use.

## Self-describing screens

A first-time visitor should never have to guess what a screen is for. The home page opens with a
plain-language paragraph describing what the system does end to end, each card blurb says what that
screen answers, and **every** surface renders a one-paragraph description directly under its `<h1>`
via the shared `pageIntro()` helper (`src/ui/chrome.ts`, styled by `.page-intro` in `THEME`):

| Screen              | What its description tells the reader                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Pipeline health** | Whether the system is running and where calls are right now — per-step health, today's totals, spend vs budget. Counts only.    |
| **All calls**       | One row per call and what became of it: finished, deliberately skipped (with the reason), waiting for review, or failed.        |
| **Knowledge base**  | The finished per-call records — intent, category, urgency, symptoms, customer's own words — searchable, filterable, exportable. |
| **Review queue**    | The calls the system paused because it wasn't confident, and what a reviewer does about them.                                   |
| **Review detail**   | What one paused call needs from the reviewer, and that the transcript shown is already anonymised.                              |

The copy is free to change; its presence is not — `test/ui/page-intro.test.ts` asserts every view
renders a description of at least a sentence, that the intro is styled, and that `pageIntro()`
escapes like the rest of the chrome. Descriptions are static prose: no PII, no per-call data.

## Why it composes cleanly

All three surfaces build on the same `createInternalApp` factory, share one auth/session/CSRF/
rate-limit stack, and declare **fully disjoint** route paths; no route module registers a
decorator/plugin/hook. So registering all three plus the home route on one Fastify instance is
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
  rate-limit vars, and `REDACTION_DENY_LIST_PATH` (knowledge + review residual-egress guard).
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
