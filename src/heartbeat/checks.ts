import type { Config } from '../config/schema.js';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';

/**
 * The three long-running components that each own an EXTERNAL dead-man's switch (Task 7.1).
 * Each pings its OWN check on its OWN cadence; a shared check is deliberately impossible
 * because a single green light would mask a dead cron.
 */
export type HeartbeatComponent =
  'worker' | 'reconciliation-cron' | 'retention-cron' | 'evaluation-cron';

/**
 * SINGLE source of truth mapping a component to its own check-URL config variable. This is
 * the only place the mapping exists, so a component's ping can never be routed to another
 * component's URL — resolve a URL only through {@link checkUrlFor} / {@link checkUrlVar}.
 */
const CHECK_URL_VAR = {
  worker: 'WORKER_CHECK_URL',
  'reconciliation-cron': 'RECONCILIATION_CHECK_URL',
  'retention-cron': 'RETENTION_CHECK_URL',
  'evaluation-cron': 'EVALUATION_CHECK_URL',
} as const satisfies Record<HeartbeatComponent, keyof Config>;

/** Environments where a component running unmonitored is a broken backstop: fail fast. */
const MONITORED_ENVS: ReadonlySet<Config['NODE_ENV']> = new Set(['staging', 'production']);

/** The exact env-var name backing a component's check URL (for error messages / lockstep). */
export function checkUrlVar(component: HeartbeatComponent): keyof Config {
  return CHECK_URL_VAR[component];
}

/** A component's own configured check URL, or undefined when unset (dev/test skip the ping). */
export function checkUrlFor(config: Config, component: HeartbeatComponent): string | undefined {
  return config[CHECK_URL_VAR[component]];
}

/**
 * Fail-fast guard for a component's entrypoint: in staging/production the component MUST have
 * its OWN check URL, or it would run unmonitored — a silently unmonitored backstop is a
 * broken backstop. Emits CONFIG_MISSING_OR_INVALID that NAMES that component's exact variable
 * (the same shape as requireDialpadApiKey). Outside those environments the ping is optional.
 */
export function requireCheckUrl(config: Config, component: HeartbeatComponent): void {
  if (MONITORED_ENVS.has(config.NODE_ENV) && !checkUrlFor(config, component)) {
    const varName = String(checkUrlVar(component));
    throw new ConfigError(
      [varName],
      `${CONFIG_ERROR_CODE}: ${varName} is required in ${config.NODE_ENV} — ${component} must ping its own external check`,
    );
  }
}
