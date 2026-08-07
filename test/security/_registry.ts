/**
 * The single source of truth for the cross-cutting security audit (Task 9.1). Every HTTP surface
 * in the system — live or planned — is described here: which shared app factory it builds on, which
 * routes it exposes, and which two suites prove it (a FACTORY proof vs. a real-SURFACE proof).
 *
 * The DB-less `conformance.test.ts` guard reads this registry and fails if a real route or a
 * listener-binding service is not represented, so a new surface CANNOT be added without registering
 * it here and joining its declared suite. The live suites (`internal-surfaces`,
 * `dialpad-webhook-surface`) and the gated placeholder (`planned-surfaces`) also read it.
 *
 * Two DISTINCT suite fields (never conflated):
 *  - `sharedFactorySuite` — the SYNTHETIC proof that the surface's factory enforces the shared
 *    hardening chain. For webhook surfaces this is `webhook-conformance` (a generic provider). It is
 *    NEVER a real-surface proof.
 *  - `liveSuite` — the REAL surface proof (actual routes + DB/queue side effects). A `status:'live'`
 *    webhook surface may NOT use `webhook-conformance` here (a factory proof can never stand in for
 *    real receiver coverage).
 */

/** The suites that can prove a surface. Keep in lockstep with the test file basenames. */
export type SuiteName =
  | 'internal-surfaces'
  | 'webhook-conformance'
  | 'dialpad-webhook-surface'
  | 'servicetitan-webhook-surface';

export type FactoryKind = 'internal' | 'webhook';
export type SurfaceStatus = 'live' | 'planned';

/**
 * How a route must treat a `MALICIOUS_PAYLOADS` case (finding #5):
 *  - `reject` — state-changing routes (all POSTs) MUST reject with the route's expected code and
 *    leave no side effect.
 *  - `ignore-or-escape` — read-only routes MAY return 200 ONLY when the malicious value is
 *    ignored/escaped: absent-or-neutralized in the response, no PII leak, no state mutation. A
 *    client-error (`REQUEST_MALFORMED`) is also acceptable; a 5xx or a reflected/executable value
 *    is not.
 */
export type MaliciousPolicy = 'reject' | 'ignore-or-escape';

export interface RouteSpec {
  method: 'GET' | 'POST';
  /** The Fastify route path exactly as declared (params like `:id` kept literal). */
  path: string;
  /** State-changing routes get CSRF + body-parsing negatives + the reject policy. */
  stateChanging: boolean;
  /** `true` only for the webhook receiver (auth is signature-based, not session). */
  public: boolean;
  maliciousPolicy: MaliciousPolicy;
}

export interface SurfaceSpec {
  name: string;
  /** The `src/services/*.ts` entrypoint that binds the listener (for the conformance cross-check). */
  bootFile: string;
  factory: FactoryKind;
  status: SurfaceStatus;
  /** The synthetic factory proof (webhook surfaces only carry a meaningful value). */
  sharedFactorySuite: SuiteName;
  /** The REAL surface proof. Must not be `webhook-conformance` for a live webhook surface. */
  liveSuite: SuiteName;
  /** The `describe.todo` name in `planned-surfaces.test.ts` — set iff `status:'planned'`. */
  plannedPlaceholder?: string;
  routes: RouteSpec[];
  /** How the surface authenticates: session (internal) or webhook signature (public). */
  authMode: 'session' | 'webhook-signature';
  /** Human-readable surface-specific checks, mirrored into docs/security-audit.md. */
  surfaceChecks: string[];
}

const readOnly = (path: string): RouteSpec => ({
  method: 'GET',
  path,
  stateChanging: false,
  public: false,
  maliciousPolicy: 'ignore-or-escape',
});

const stateChanging = (path: string): RouteSpec => ({
  method: 'POST',
  path,
  stateChanging: true,
  public: false,
  maliciousPolicy: 'reject',
});

export const SURFACES: readonly SurfaceSpec[] = [
  {
    // The combined single-entry-point service. It mounts the status, knowledge-base, and review
    // route modules (each already registered under its own surface below) plus its own `GET /`
    // home page, all on one `createInternalApp` instance under one session. Listed FIRST so its
    // unique `registerConsoleHomeRoute` marker maps `console-surface.ts` to THIS surface before the
    // per-surface markers (which also match, since the file calls all three register functions).
    name: 'console',
    bootFile: 'src/services/console-surface.ts',
    factory: 'internal',
    status: 'live',
    sharedFactorySuite: 'internal-surfaces',
    liveSuite: 'internal-surfaces',
    // The home route plus the NOTE-REVIEW routes are registered here. The status/knowledge/review
    // literals are discovered from their own files and belong to their own surfaces, but the note
    // surface has NO single-surface service of its own — console-surface.ts is the only file that
    // mounts it and the only one that binds a listener for it, so this is its surface entry.
    routes: [
      readOnly('/'),
      readOnly('/notes'),
      readOnly('/notes.json'),
      readOnly('/notes/:callId'),
      readOnly('/notes/:callId.json'),
      readOnly('/notes/:callId/transcript.json'),
      stateChanging('/notes/:callId/feedback'),
    ],
    authMode: 'session',
    surfaceChecks: [
      'single entry point — mounts status + knowledge-base + review + notes on one app under one session',
      'home page (GET /) is read-only, self-contained HTML — no PII, no external assets',
      'logout is CSRF-protected (POST /auth/logout via embedded per-session token)',
      'inherits the shared createInternalApp hardening — no self-rolled protection',
      'notes: reads ONLY technician_notes + structured_knowledge + clean_transcripts — never raw_transcripts, the vault, or the key provider (module-graph guard)',
      'notes transcript: residual-PII hit withholds the WHOLE body (fail closed); absent/soft/hard-deleted all answer the same 200 so ids cannot be enumerated',
      'notes feedback: CSRF-protected, append-only, never mutates technician_notes; off-vocabulary field_path/enum → REQUEST_MALFORMED before any write',
      'notes: note_prompt_version comes from the note, never the request (.strict() rejects a supplied one)',
      'notes: no free-text input anywhere — the 18 free-text field paths admit no correction value',
    ],
  },
  {
    name: 'status',
    bootFile: 'src/services/status-surface.ts',
    factory: 'internal',
    status: 'live',
    sharedFactorySuite: 'internal-surfaces',
    liveSuite: 'internal-surfaces',
    routes: [
      readOnly('/status'),
      readOnly('/status.json'),
      readOnly('/calls'),
      readOnly('/calls.json'),
    ],
    authMode: 'session',
    surfaceChecks: [
      'read-only — no state-changing route, no CSRF surface',
      'authenticated response exposes only sanitized health/counts',
      'no raw failure_snapshot detail, assignee, or clean-transcript text ever leaves',
    ],
  },
  {
    name: 'review',
    bootFile: 'src/services/review-surface.ts',
    factory: 'internal',
    status: 'live',
    sharedFactorySuite: 'internal-surfaces',
    liveSuite: 'internal-surfaces',
    routes: [
      readOnly('/review.json'),
      readOnly('/review'),
      readOnly('/review/:id.json'),
      readOnly('/review/:id'),
      stateChanging('/review/:id/actions/:action'),
      stateChanging('/review/:id/reveal-raw'),
    ],
    authMode: 'session',
    surfaceChecks: [
      'detail view never preloads raw/vault',
      'reveal-raw gated by requireElevatedReviewer (standard reviewer → 403 AUTH_FORBIDDEN)',
      'elevated reveal scoped to the selected review_queue_id; cross-call token → 409',
      'each action writes exactly one sanitized operator_actions row (token label, never plaintext)',
      'reprocess carries an idempotency key — no duplicate structured_knowledge / enqueue',
      'correct_extraction rejects reviewer free-text / raw PII (enums only)',
    ],
  },
  {
    name: 'knowledge-base',
    bootFile: 'src/services/knowledge-surface.ts',
    factory: 'internal',
    status: 'live',
    sharedFactorySuite: 'internal-surfaces',
    liveSuite: 'internal-surfaces',
    routes: [
      readOnly('/knowledge'),
      readOnly('/knowledge.json'),
      readOnly('/knowledge/export.csv'),
      readOnly('/knowledge/export.json'),
    ],
    authMode: 'session',
    surfaceChecks: [
      'read-only — no state-changing route, no CSRF surface',
      'reads ONLY structured_knowledge — never raw_transcripts / token_vault / match_keys',
      'labeled-PII-corpus values absent from JSON, CSV, JSON export, and the summary',
      'CSV↔JSON export parity over the filtered view',
      'residual-PII-shaped q → REQUEST_MALFORMED before any DB read',
    ],
  },
  {
    name: 'dialpad-webhook',
    bootFile: 'src/services/webhook-receiver.ts',
    factory: 'webhook',
    status: 'live',
    // The synthetic factory proof lives in webhook-conformance; the REAL receiver proof is its own
    // liveSuite (never webhook-conformance — enforced by conformance assertion (c2)).
    sharedFactorySuite: 'webhook-conformance',
    liveSuite: 'dialpad-webhook-surface',
    routes: [
      {
        method: 'POST',
        path: '/webhooks/dialpad',
        stateChanging: true,
        public: true,
        maliciousPolicy: 'reject',
      },
    ],
    authMode: 'webhook-signature',
    surfaceChecks: [
      'HS256 JWT alg-pinned; primary + optional previous secret; constant-time compare',
      'invalid/tampered/unsigned/alg:none → WEBHOOK_SIGNATURE_INVALID before any work; sink un-called',
      'replay of an event id → WEBHOOK_REPLAY_DETECTED; stale/future iat → WEBHOOK_TIMESTAMP_INVALID',
      'valid event ingests exactly once; raw_webhook_events keeps only allowlisted metadata, phone/name hashed',
      'no transcript/message content stored; planted PII never in response, logs, or stored row',
    ],
  },
  {
    name: 'servicetitan-webhook',
    bootFile: 'src/services/servicetitan-receiver.ts (Task 12.1 — not yet built)',
    factory: 'webhook',
    status: 'planned',
    sharedFactorySuite: 'webhook-conformance',
    liveSuite: 'servicetitan-webhook-surface',
    plannedPlaceholder: 'servicetitan-webhook',
    routes: [],
    authMode: 'webhook-signature',
    surfaceChecks: [
      'future (Phase 12) — does NOT gate 9.1 signoff',
      'weak match writes nothing; strong match writes exactly one additive note',
      'rerun updates rather than duplicates; human notes never overwritten',
      'SERVICETITAN_AUTH_FAILED / SERVICETITAN_WRITE_FAILED / SERVICETITAN_MATCH_WEAK on failure',
    ],
  },
];

/** Live surfaces only. */
export const LIVE_SURFACES = SURFACES.filter((s) => s.status === 'live');
/** Planned surfaces only — each must have a placeholder in planned-surfaces.test.ts. */
export const PLANNED_SURFACES = SURFACES.filter((s) => s.status === 'planned');

/** The registry's `status:'planned'` placeholder names — tied to planned-surfaces.test.ts by the
 * conformance equality guard (assertion (e)). */
export const REGISTRY_PLANNED_PLACEHOLDERS: readonly string[] = PLANNED_SURFACES.map((s) => {
  if (!s.plannedPlaceholder) {
    throw new Error(`planned surface ${s.name} is missing plannedPlaceholder`);
  }
  return s.plannedPlaceholder;
});

/** Flatten every declared route across all surfaces, tagged with its surface name. */
export interface FlatRoute extends RouteSpec {
  surface: string;
}
export const ALL_ROUTES: readonly FlatRoute[] = SURFACES.flatMap((s) =>
  s.routes.map((r) => ({ ...r, surface: s.name })),
);

/** Does the registry declare this (method, path)? Used by the conformance route cross-check. */
export function registryHasRoute(method: string, path: string): boolean {
  return ALL_ROUTES.some((r) => r.method === method.toUpperCase() && r.path === path);
}
