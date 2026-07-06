import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LIVE_SURFACES,
  PLANNED_SURFACES,
  REGISTRY_PLANNED_PLACEHOLDERS,
  SURFACES,
  registryHasRoute,
  type SurfaceSpec,
} from './_registry.js';
import { EXPECTED_STATUS, type ExpectedCode } from './_security-suite.js';
import { httpStatusFor } from '../../src/http/index.js';
import type { ErrorCode } from '../../src/failure-model/index.js';

/**
 * The DB-less, always-on "cannot bypass" guard (Task 9.1). It runs in CI with or without a database,
 * so the middleware/route conformance is enforced on every PR. Modeled on
 * `test/db/restricted-import-guard.test.ts` (fs-scan, precise regexes, no live app).
 *
 * It fs-scans `src/**` for (a) self-rolled hardening outside `src/http/`, (b) route declarations that
 * are not registered in `SURFACES.routes`, and (c) `src/services/*` listener bindings that are not a
 * `status:'live'` surface joined to a real `liveSuite`. It also pins the error-code contract via the
 * EXPORTED `httpStatusFor` (not source-text parsing) and the live/planned ↔ placeholder integrity.
 */

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

interface SrcFile {
  rel: string; // posix-relative to src/, e.g. 'status/routes.ts'
  content: string;
}

function listSrcFiles(): SrcFile[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const rel = f.split(sep).join('/');
      return { rel, content: readFileSync(`${SRC_DIR}${rel}`, 'utf8') };
    });
}

const ALL_FILES = listSrcFiles();
const OUTSIDE_HTTP = ALL_FILES.filter((f) => !f.rel.startsWith('http/'));

/* -------------------------------------------------------------------------------------------------
 * (a) No self-rolled hardening outside src/http.
 * ---------------------------------------------------------------------------------------------- */

const HARDENING_TOKENS: readonly { name: string; re: RegExp }[] = [
  { name: 'fastify() raw app', re: /(?:^|[^.\w])fastify\s*\(/m },
  { name: '.addHook(', re: /\.addHook\s*\(/ },
  { name: '.setErrorHandler(', re: /\.setErrorHandler\s*\(/ },
  { name: '.setNotFoundHandler(', re: /\.setNotFoundHandler\s*\(/ },
  { name: 'bodyLimit', re: /bodyLimit\s*:/ },
  { name: '.addContentTypeParser(', re: /\.addContentTypeParser\s*\(/ },
  { name: '.removeAllContentTypeParsers(', re: /\.removeAllContentTypeParsers\s*\(/ },
  {
    name: 'hardening plugin registration',
    re: /@fastify\/(session|cookie|csrf-protection|rate-limit|helmet)/,
  },
];

/**
 * The Dialpad receiver legitimately installs a raw-body content-type parser so a bare-JWT body is
 * not rejected as malformed JSON. It sits ON TOP of `createWebhookApp` (not a bypass) and is the
 * single documented owner (see `src/dialpad/webhook/route.ts` and docs/security-audit.md).
 *
 * The allowlist is TOKEN-level, not file-level: only the two content-type-parser tokens are exempt
 * for that ONE file, each expected exactly once. If that file later adds `addHook`,
 * `setErrorHandler`, `fastify()`, `bodyLimit`, or a second parser call, the guard still fails.
 */
const HARDENING_ALLOWLIST: Record<string, ReadonlyMap<string, number>> = {
  'dialpad/webhook/route.ts': new Map([
    ['.addContentTypeParser(', 1],
    ['.removeAllContentTypeParsers(', 1],
  ]),
};

/** Count non-overlapping matches of a token regex in a file. */
function countMatches(content: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (content.match(global) ?? []).length;
}

describe('security conformance — no self-rolled hardening outside src/http', () => {
  it('every HTTP protection comes from the Task 2.3 factories', () => {
    const offenders: string[] = [];
    for (const file of OUTSIDE_HTTP) {
      const allowed = HARDENING_ALLOWLIST[file.rel];
      for (const token of HARDENING_TOKENS) {
        if (!token.re.test(file.content)) continue;
        const exemptCount = allowed?.get(token.name);
        if (exemptCount === undefined) {
          offenders.push(`${file.rel} :: ${token.name}`);
          continue;
        }
        // Exempt token — but only up to the documented occurrence count, so a NEW call of an
        // otherwise-allowed parser token in the same file still trips the guard.
        const actual = countMatches(file.content, token.re);
        if (actual > exemptCount) {
          offenders.push(`${file.rel} :: ${token.name} (${actual} > allowed ${exemptCount})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * (b) Every discovered route is registered in SURFACES.routes.
 * ---------------------------------------------------------------------------------------------- */

interface DiscoveredRoute {
  method: string;
  path: string;
  file: string;
}

const ROUTE_LITERAL = /\b[A-Za-z_$][\w$]*\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`]*)\2/g;

/** Resolve a `const NAME = '/literal'` (same file first, then any file). */
function resolveIdentifierPath(ident: string, file: SrcFile): string | undefined {
  const re = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*=\\s*['"\`](/[^'"\`]+)['"\`]`);
  const local = re.exec(file.content);
  if (local) return local[1];
  for (const f of ALL_FILES) {
    const m = re.exec(f.content);
    if (m) return m[1];
  }
  return undefined;
}

function discoverRoutes(): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  for (const file of OUTSIDE_HTTP) {
    // Direct route literals (status/review/knowledge).
    for (const m of file.content.matchAll(ROUTE_LITERAL)) {
      found.push({ method: m[1]!.toUpperCase(), path: m[3]!, file: file.rel });
    }
    // Webhook route registrations (Dialpad) — path may be an identifier constant.
    if (/\.registerWebhook\s*\(/.test(file.content)) {
      const pathTok =
        /registerWebhook\s*\(\s*\{[\s\S]*?path:\s*(['"`](\/[^'"`]+)['"`]|[A-Za-z_$][\w$]*)/.exec(
          file.content,
        );
      if (pathTok) {
        const raw = pathTok[1]!;
        const path =
          raw.startsWith('/') || raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')
            ? raw.replace(/['"`]/g, '')
            : resolveIdentifierPath(raw, file);
        if (path) found.push({ method: 'POST', path, file: file.rel });
      }
    }
  }
  return found;
}

const DISCOVERED = discoverRoutes();

describe('security conformance — every route is registered', () => {
  it('discovers the known live routes (sanity — the scanner actually finds routes)', () => {
    // A canary so a broken regex cannot vacuously pass (b).
    const paths = DISCOVERED.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /status');
    expect(paths).toContain('POST /review/:id/reveal-raw');
    expect(paths).toContain('GET /knowledge/export.csv');
    expect(paths).toContain('POST /webhooks/dialpad');
  });

  it('every discovered route path/method appears in SURFACES.routes', () => {
    const unregistered = DISCOVERED.filter((r) => !registryHasRoute(r.method, r.path)).map(
      (r) => `${r.method} ${r.path} (${r.file})`,
    );
    expect(unregistered).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * (c) Every listener-binding service is a live surface joined to a real liveSuite.
 * (c2) No live webhook surface uses webhook-conformance as its liveSuite.
 * (d) No planned surface has a live listener.
 * ---------------------------------------------------------------------------------------------- */

function servicesBindingListeners(): string[] {
  return ALL_FILES.filter(
    (f) => f.rel.startsWith('services/') && /\.listen\s*\(/.test(f.content),
  ).map((f) => `src/${f.rel}`);
}

const LISTENER_SERVICES = servicesBindingListeners();

/** The register call each surface uses, so we can match a service file to a surface. */
const SURFACE_MARKERS: Record<string, RegExp> = {
  status: /registerStatusRoutes/,
  review: /registerReviewRoutes/,
  'knowledge-base': /registerKnowledgeRoutes/,
  'dialpad-webhook': /buildWebhookReceiverApp|registerDialpadWebhook/,
};

function surfaceForService(file: SrcFile): SurfaceSpec | undefined {
  for (const surface of SURFACES) {
    const marker = SURFACE_MARKERS[surface.name];
    if (marker && marker.test(file.content)) return surface;
  }
  return undefined;
}

describe('security conformance — services ↔ surfaces', () => {
  it('every service that binds a listener is a live surface with a real liveSuite', () => {
    const problems: string[] = [];
    for (const rel of LISTENER_SERVICES) {
      const file = ALL_FILES.find((f) => `src/${f.rel}` === rel)!;
      const surface = surfaceForService(file);
      if (!surface) {
        problems.push(`${rel}: binds a listener but maps to no registered surface`);
        continue;
      }
      if (surface.status !== 'live') {
        problems.push(`${rel}: surface ${surface.name} binds a listener but is not status:'live'`);
      }
      if (surface.bootFile !== rel) {
        problems.push(`${rel}: surface ${surface.name} bootFile is ${surface.bootFile}`);
      }
      // (c2) a live webhook surface's liveSuite may never be the synthetic factory proof.
      if (surface.factory === 'webhook' && surface.liveSuite === 'webhook-conformance') {
        problems.push(`${rel}: live webhook ${surface.name} uses webhook-conformance as liveSuite`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every live surface actually binds a listener (both directions)', () => {
    const missing = LIVE_SURFACES.filter((s) => !LISTENER_SERVICES.includes(s.bootFile)).map(
      (s) => `${s.name} (${s.bootFile})`,
    );
    expect(missing).toEqual([]);
  });

  it('no planned surface has a live listener', () => {
    const wired = PLANNED_SURFACES.filter((s) => LISTENER_SERVICES.includes(s.bootFile)).map(
      (s) => s.name,
    );
    expect(wired).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * (e) live/planned ↔ placeholder integrity.
 * ---------------------------------------------------------------------------------------------- */

describe('security conformance — live/planned integrity', () => {
  it('the registry planned set has exactly one gated placeholder (ServiceTitan)', () => {
    expect([...REGISTRY_PLANNED_PLACEHOLDERS].sort()).toEqual(['servicetitan-webhook']);
  });

  it('no live surface is left as a planned placeholder', () => {
    const liveNames = new Set(LIVE_SURFACES.map((s) => s.name));
    const overlap = REGISTRY_PLANNED_PLACEHOLDERS.filter((n) => liveNames.has(n));
    expect(overlap).toEqual([]);
  });

  it('the four dependency surfaces (status, review, KB, Dialpad) are all live this PR', () => {
    const live = new Set(LIVE_SURFACES.map((s) => s.name));
    for (const name of ['status', 'review', 'knowledge-base', 'dialpad-webhook']) {
      expect(live.has(name), `${name} must be live`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * Error-code contract — via the EXPORTED helper, not source-text parsing (findings #9, #4).
 * ---------------------------------------------------------------------------------------------- */

describe('security conformance — error-code contract', () => {
  it('httpStatusFor resolves every 9.1 code to its expected status', () => {
    for (const code of Object.keys(EXPECTED_STATUS) as ExpectedCode[]) {
      expect(httpStatusFor(code as ErrorCode), code).toBe(EXPECTED_STATUS[code]);
    }
  });
});
