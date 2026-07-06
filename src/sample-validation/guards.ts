import type { Config } from '../config/schema.js';
import { SampleValidationError } from './errors.js';

/**
 * Environment + resource guards for the sample-validation harness (Task 11.1).
 *
 * Two independent lines of defense against ever touching production data:
 *  1. `assertStagingEnvironment` — NODE_ENV MUST be `staging`. Production or any non-staging env is
 *     refused even when credentials are present.
 *  2. `assertNoProductionResources` — a defense-in-depth host scan: even inside a staging process, a
 *     database / queue / service endpoint whose HOST names a production marker is refused, so a
 *     mis-set connection string can never point the harness at a production store.
 */

/** Host substrings that mark a resource as production. Conservative — a match refuses the run. */
export const DEFAULT_PRODUCTION_HOST_MARKERS: readonly string[] = ['prod', 'production'];

/** Refuse unless running in staging. */
export function assertStagingEnvironment(config: Config): void {
  if (config.NODE_ENV !== 'staging') {
    throw new SampleValidationError(
      'not_staging',
      `sample-validation harness runs in staging only (NODE_ENV=${config.NODE_ENV})`,
      { node_env: config.NODE_ENV },
    );
  }
}

/** A resource endpoint to screen: `label` is the sanitized identifier surfaced on refusal. */
export interface ResourceEndpoint {
  label: string;
  url: string | undefined;
}

export interface ProductionResourceCheck {
  databaseUrl?: string | undefined;
  queueUrl?: string | undefined;
  endpoints?: readonly ResourceEndpoint[];
}

export interface ResourceGuardOptions {
  productionMarkers?: readonly string[] | undefined;
}

/**
 * Extract the host from a URL for marker screening. Parsing isolates the host from userinfo
 * (credentials) and the path so a secret containing "prod" cannot trip the guard. An unparseable
 * value falls back to the whole string so a malformed-but-production value is not silently allowed.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function markerHit(url: string | undefined, markers: readonly string[]): string | undefined {
  if (!url) return undefined;
  const host = hostOf(url);
  return markers.find((m) => host.includes(m.toLowerCase()));
}

/** Build the resource screen for a config: its database, queue, and known service endpoints. */
export function configResourceCheck(
  config: Config,
  extraEndpoints: readonly ResourceEndpoint[] = [],
): ProductionResourceCheck {
  return {
    databaseUrl: config.DATABASE_URL,
    queueUrl: config.REDIS_URL,
    endpoints: [
      { label: 'dialpad', url: config.DIALPAD_BASE_URL },
      { label: 'oidc', url: config.OIDC_ISSUER_URL },
      ...extraEndpoints,
    ],
  };
}

export interface StagingRunGuardOptions {
  productionMarkers?: readonly string[] | undefined;
  resourceEndpoints?: readonly ResourceEndpoint[] | undefined;
}

/**
 * The combined staging + no-production-resource guard, derived entirely from config. Pure (no
 * connections, no DB) so an entrypoint can call it FIRST — before readiness, before any database or
 * queue connection is constructed — so a misconfigured run is refused before it can touch anything.
 */
export function assertStagingResources(config: Config, options: StagingRunGuardOptions = {}): void {
  assertStagingEnvironment(config);
  assertNoProductionResources(configResourceCheck(config, options.resourceEndpoints ?? []), {
    productionMarkers: options.productionMarkers,
  });
}

/** Refuse if any configured database / queue / service endpoint resolves to a production host. */
export function assertNoProductionResources(
  check: ProductionResourceCheck,
  options: ResourceGuardOptions = {},
): void {
  const markers = options.productionMarkers ?? DEFAULT_PRODUCTION_HOST_MARKERS;

  const screened: ResourceEndpoint[] = [
    { label: 'database', url: check.databaseUrl },
    { label: 'queue', url: check.queueUrl },
    ...(check.endpoints ?? []),
  ];

  for (const { label, url } of screened) {
    const marker = markerHit(url, markers);
    if (marker !== undefined) {
      throw new SampleValidationError(
        'production_resource',
        `refusing to run: the "${label}" resource host names a production marker`,
        { resource: label, marker },
      );
    }
  }
}
