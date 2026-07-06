import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { httpStatusFor, toHttpError } from '../../src/http/index.js';
import type { LoggedIn } from '../http/_helpers.js';

/**
 * The shared harness for the Task 9.1 cross-cutting security suite. It holds the code contract
 * (`EXPECTED_STATUS`, validated via the EXPORTED `httpStatusFor`/`toHttpError` — never source-text
 * parsing of the private maps), the PII-egress asserts, the malicious payload/query batteries, the
 * JWT signer + adversarial variants (the same trivial HS256 pattern the Dialpad tests use — no
 * net-new builder), and the reusable negative-matrix registrars for internal + state-changing routes.
 *
 * Every negative asserts a CONCRETE outcome — an exact code, a PII-free `{error, message,
 * request_id}` body, no prototype pollution, and (for writes) a proven side-effect-free state — so
 * no assertion is a tautology. The step-4 negative controls (a bare `fastify()` app; an unregistered
 * route) fail these, proving they check real enforcement.
 */

/* -------------------------------------------------------------------------------------------------
 * Error-code contract (findings #9, #4). An explicit list of the codes 9.1 relies on; the status is
 * asserted against the exported helper so a drift in `HTTP_STATUS_BY_CODE` fails the suite.
 * ---------------------------------------------------------------------------------------------- */

export const EXPECTED_STATUS = {
  AUTH_REQUIRED: 401,
  AUTH_FORBIDDEN: 403,
  CSRF_TOKEN_INVALID: 403,
  REQUEST_BODY_TOO_LARGE: 413,
  REQUEST_MALFORMED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMIT_EXCEEDED: 429,
  WEBHOOK_SIGNATURE_INVALID: 401,
  WEBHOOK_TIMESTAMP_INVALID: 400,
  WEBHOOK_REPLAY_DETECTED: 409,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type ExpectedCode = keyof typeof EXPECTED_STATUS;

/** The resolved contract per code: `{ status, message }` from the exported helpers. */
export const EXPECTED: Record<ExpectedCode, { status: number; message: string }> =
  Object.fromEntries(
    (Object.keys(EXPECTED_STATUS) as ExpectedCode[]).map((code) => [
      code,
      { status: httpStatusFor(code), message: toHttpError({ error_code: code }).body.message },
    ]),
  ) as Record<ExpectedCode, { status: number; message: string }>;

/* -------------------------------------------------------------------------------------------------
 * PII seeds + assertion. Planted through payloads, headers, query, and error contexts; asserted
 * absent from response bodies, captured pino lines, and audit/alert rows.
 * ---------------------------------------------------------------------------------------------- */

export const PII_SEEDS = {
  email: 'sneaky.caller@example.com',
  phone: '555-867-5309',
  name: 'Jebediah Q Testperson',
  address: '742 Evergreen Terrace, Springfield',
  ssn: '078-05-1120',
  vaultValue: 'VAULT_PLAINTEXT_Zx9q7',
  customerLanguage: 'my basement is flooding right now please hurry',
} as const;

export const ALL_PII_SEEDS: readonly string[] = Object.values(PII_SEEDS);

/** Assert none of the PII seeds appear anywhere in `haystack` (a response body or a joined log). */
export function assertNoPii(haystack: string, where = 'response'): void {
  for (const seed of ALL_PII_SEEDS) {
    expect(haystack.includes(seed), `${where} leaked PII seed: ${seed}`).toBe(false);
  }
}

/** No route may pollute `Object.prototype` via a `__proto__`/`constructor` key. */
export function assertNoPrototypePollution(): void {
  expect(({} as Record<string, unknown>).polluted, 'Object.prototype polluted').toBeUndefined();
  expect(
    (Object.prototype as Record<string, unknown>).polluted,
    'Object.prototype polluted',
  ).toBeUndefined();
}

/* -------------------------------------------------------------------------------------------------
 * Safe-error-shape assertions.
 * ---------------------------------------------------------------------------------------------- */

/** Assert a middleware error: exact status + code + the minimal `{error, message, request_id}` body,
 * with no PII in the payload. */
export function expectMiddlewareError(res: LightMyRequestResponse, code: ExpectedCode): void {
  expect(res.statusCode, `${code} expected status`).toBe(EXPECTED_STATUS[code]);
  const body = res.json<Record<string, unknown>>();
  expect(body.error, `${code} error field`).toBe(code);
  expect(Object.keys(body).sort()).toEqual(['error', 'message', 'request_id']);
  expect(typeof body.message).toBe('string');
  assertNoPii(res.payload);
}

/** Assert the framework 404 shape. */
export function expectNotFound(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(404);
  const body = res.json<Record<string, unknown>>();
  expect(body.error).toBe('NOT_FOUND');
  expect(Object.keys(body).sort()).toEqual(['error', 'message', 'request_id']);
}

/* -------------------------------------------------------------------------------------------------
 * Malicious payload battery (finding #6) — bodies as RAW JSON strings so a literal `__proto__`
 * OWN key survives (an object literal `{__proto__: …}` would set the prototype, not a key).
 * ---------------------------------------------------------------------------------------------- */

export interface MaliciousPayload {
  name: string;
  rawBody: string;
}

const DEEP = 60;

export const MALICIOUS_PAYLOADS: readonly MaliciousPayload[] = [
  {
    name: 'proto-pollution __proto__',
    rawBody: '{"__proto__":{"polluted":"yes"},"stage":"redact"}',
  },
  {
    name: 'proto-pollution constructor.prototype',
    rawBody: '{"constructor":{"prototype":{"polluted":"yes"}}}',
  },
  {
    name: 'xss <script> in field',
    rawBody: JSON.stringify({ stage: '<script>alert(1)</script>' }),
  },
  { name: 'path traversal', rawBody: JSON.stringify({ stage: '../../../../etc/passwd' }) },
  {
    name: 'sql injection',
    rawBody: JSON.stringify({ stage: "redact'; DROP TABLE review_queue;--" }),
  },
  {
    name: 'header/newline injection',
    rawBody: JSON.stringify({ stage: 'redact\r\nSet-Cookie: pwned=1' }),
  },
  { name: 'type confusion (array body)', rawBody: '["not","an","object"]' },
  {
    name: 'type confusion (object for scalar)',
    rawBody: JSON.stringify({ stage: { evil: true } }),
  },
  {
    name: 'planted PII in field',
    rawBody: JSON.stringify({ stage: PII_SEEDS.customerLanguage, note: PII_SEEDS.email }),
  },
  { name: 'deeply nested json', rawBody: `${'{"a":'.repeat(DEEP)}1${'}'.repeat(DEEP)}` },
];

/* -------------------------------------------------------------------------------------------------
 * Malicious query battery for read-only routes. HTML routes must ESCAPE a reflected value; JSON
 * routes neutralize it by encoding (a `<script>` string is inert JSON data).
 * ---------------------------------------------------------------------------------------------- */

export interface MaliciousQuery {
  name: string;
  query: string;
  /** Only checked for `kind:'html'` routes. */
  htmlMustNotContain?: string;
}

export const MALICIOUS_QUERIES: readonly MaliciousQuery[] = [
  {
    name: 'xss <script>',
    query: 'q=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    htmlMustNotContain: '<script>alert(1)</script>',
  },
  { name: 'proto-pollution __proto__', query: '__proto__[polluted]=yes' },
  { name: 'proto-pollution constructor', query: 'constructor[prototype][polluted]=yes' },
  { name: 'path traversal', query: 'q=..%2F..%2F..%2Fetc%2Fpasswd' },
  { name: 'sql injection', query: 'q=%27%20OR%201%3D1%3B--' },
  { name: 'planted PII', query: `q=${encodeURIComponent(PII_SEEDS.email)}` },
];

/* -------------------------------------------------------------------------------------------------
 * JWT signer + adversarial variants (reuse the trivial HS256 pattern from the Dialpad tests).
 * ---------------------------------------------------------------------------------------------- */

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Sign a compact HS256 JWT the way Dialpad does (header.body.sig). */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** An `alg:none` token (unsigned) — must be refused by an alg-pinned verifier. */
export function signAlgNoneJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.`;
}

/** A valid token with its final signature byte flipped. */
export function tamperJwt(token: string): string {
  const flipped = token.endsWith('A') ? 'B' : 'A';
  return token.slice(0, -1) + flipped;
}

/* -------------------------------------------------------------------------------------------------
 * Reusable negative matrices (register their own `it`s; call inside a `describe`).
 * ---------------------------------------------------------------------------------------------- */

export interface ReadPathMatrixOpts {
  /** The live app under test (a getter, so it is built in the caller's beforeAll). */
  getApp: () => FastifyInstance;
  /** A standard authenticated session on `getApp`. */
  login: () => Promise<LoggedIn>;
  /** Every read route on this surface, tagged html/json for the reflection assertion. `path` may be
   * a getter so a per-test seeded id (e.g. a review_queue UUID) resolves at run time, not at
   * collection time. */
  readPaths: readonly { path: string | (() => string); kind: 'html' | 'json' }[];
  /** A FRESH app with a tiny IP rate limit (own MemoryRateStore) + a protected probe path. */
  rateLimit: { makeApp: () => Promise<FastifyInstance>; path: string; max: number };
}

/** Resolve a possibly-lazy path. */
function resolvePath(path: string | (() => string)): string {
  return typeof path === 'function' ? path() : path;
}

/** The shared read-only matrix: auth-required, unknown-route 404, tier-1 rate limit, malicious query. */
export function runReadPathMatrix(opts: ReadPathMatrixOpts): void {
  it('every read route requires authentication (401 AUTH_REQUIRED)', async () => {
    for (const r of opts.readPaths) {
      const res = await opts.getApp().inject({ method: 'GET', url: resolvePath(r.path) });
      expectMiddlewareError(res, 'AUTH_REQUIRED');
    }
  });

  it('an unknown route returns a PII-free 404 (authenticated)', async () => {
    const session = await opts.login();
    const res = await opts
      .getApp()
      .inject({ method: 'GET', url: '/__no_such_route__', headers: { cookie: session.cookie } });
    expectNotFound(res);
  });

  it('trips the tier-1 IP rate limit (429 RATE_LIMIT_EXCEEDED)', async () => {
    const app = await opts.rateLimit.makeApp();
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i <= opts.rateLimit.max; i += 1) {
      last = await app.inject({ method: 'GET', url: opts.rateLimit.path });
    }
    expectMiddlewareError(last!, 'RATE_LIMIT_EXCEEDED');
    await app.close();
  });

  it('ignores or escapes malicious query params (no 5xx, no leak, no pollution)', async () => {
    const session = await opts.login();
    for (const r of opts.readPaths) {
      const path = resolvePath(r.path);
      for (const q of MALICIOUS_QUERIES) {
        const res = await opts.getApp().inject({
          method: 'GET',
          url: `${path}?${q.query}`,
          headers: { cookie: session.cookie },
        });
        expect(res.statusCode, `${path}?${q.name} must not 5xx`).toBeLessThan(500);
        assertNoPii(res.payload, `${path}?${q.name}`);
        if (r.kind === 'html' && q.htmlMustNotContain) {
          expect(res.payload, `${path} reflected unescaped ${q.name}`).not.toContain(
            q.htmlMustNotContain,
          );
        }
      }
    }
    assertNoPrototypePollution();
  });
}

export interface StatePathHardeningOpts {
  label: string;
  getApp: () => FastifyInstance;
  /** Concrete POST path (params substituted). */
  path: string;
  /** A standard authenticated session on `getApp` (cookie + CSRF token). */
  session: () => Promise<LoggedIn>;
  /** The expected rejection code for an authed+CSRF malicious body (e.g. REQUEST_MALFORMED). */
  rejectCode: ExpectedCode;
  /** Prove nothing was written after a rejected request. */
  assertNoSideEffect: () => Promise<void>;
  /**
   * Whether the route READS its body. `true` (default) → an authed+CSRF malicious body must be
   * REJECTED with `rejectCode`. `false` → the route ignores its body (e.g. reveal-raw, whose only
   * input is a query param), so the malicious-body-reject case is skipped: the factory still
   * enforces CSRF/oversized/malformed/media-type (proven by the other cases), and a non-empty body
   * carries no injection surface. See docs/security-audit.md for the reveal-raw body-strictness
   * follow-up.
   */
  includeMaliciousBody?: boolean;
}

/** The shared state-changing matrix: CSRF, body-parsing negatives, and malicious-payload rejection. */
export function runStatePathHardening(opts: StatePathHardeningOpts): void {
  const url = opts.path;

  it(`${opts.label}: requires a CSRF token (403 CSRF_TOKEN_INVALID)`, async () => {
    const session = await opts.session();
    const res = await opts.getApp().inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expectMiddlewareError(res, 'CSRF_TOKEN_INVALID');
    await opts.assertNoSideEffect();
  });

  it(`${opts.label}: rejects an oversized body (413)`, async () => {
    const res = await opts.getApp().inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(1_200_000),
    });
    expectMiddlewareError(res, 'REQUEST_BODY_TOO_LARGE');
  });

  it(`${opts.label}: rejects malformed JSON (400)`, async () => {
    const res = await opts.getApp().inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: '{"stage":',
    });
    expectMiddlewareError(res, 'REQUEST_MALFORMED');
  });

  it(`${opts.label}: rejects an unsupported content-type (415)`, async () => {
    const res = await opts.getApp().inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expectMiddlewareError(res, 'UNSUPPORTED_MEDIA_TYPE');
  });

  // Only when the route READS its body. A body-ignoring route (reveal-raw) skips this — the factory
  // still enforces CSRF/oversized/malformed/media-type above, and its body is not an operation input.
  if (opts.includeMaliciousBody ?? true) {
    it(`${opts.label}: rejects every malicious payload with no side effect`, async () => {
      const session = await opts.session();
      for (const p of MALICIOUS_PAYLOADS) {
        const res = await opts.getApp().inject({
          method: 'POST',
          url,
          headers: {
            cookie: session.cookie,
            'x-csrf-token': session.csrfToken,
            'content-type': 'application/json',
          },
          payload: p.rawBody,
        });
        expect(res.statusCode, `${p.name} expected ${opts.rejectCode}`).toBe(
          EXPECTED_STATUS[opts.rejectCode],
        );
        assertNoPii(res.payload, p.name);
        await opts.assertNoSideEffect();
      }
      assertNoPrototypePollution();
    });
  }
}
