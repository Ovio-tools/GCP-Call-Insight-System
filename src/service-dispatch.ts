import { CONFIG_ERROR_CODE, ConfigError } from './config/index.js';

/**
 * The deployable service roles — one per self-executing entrypoint under `src/services/`. Each
 * Railway service runs the SAME start command (`node dist/index.js`) and selects which service to
 * boot via the `SERVICE_ROLE` variable; the entrypoint (`src/index.ts`) dynamically imports the
 * matching module, which self-boots on import. This keeps the role a CLI-settable variable instead
 * of a per-service start command, so two services can share one codebase without a dashboard-only
 * override each.
 *
 * Keep this list in lockstep with `src/services/*.ts`; the dispatch test asserts every role maps to
 * a real entrypoint file.
 */
export const SERVICE_ROLES = [
  'worker',
  'reconciliation-cron',
  'retention-cron',
  'webhook-receiver',
  'status-surface',
  'review-surface',
  'knowledge-surface',
  'console-surface',
  'evaluation-run',
] as const;

export type ServiceRole = (typeof SERVICE_ROLES)[number];

/** Narrowing guard: true only for a known role. */
export function isServiceRole(value: string | undefined): value is ServiceRole {
  return value !== undefined && (SERVICE_ROLES as readonly string[]).includes(value);
}

/** The module specifier (relative to the compiled `dist/index.js`) whose import self-boots the
 * role. Compiled output is `dist/services/<role>.js`, a sibling of `dist/index.js`. */
export function entrypointSpecifierFor(role: ServiceRole): string {
  return `./services/${role}.js`;
}

/**
 * Resolve `SERVICE_ROLE` from the environment, or throw a `CONFIG_MISSING_OR_INVALID` that NAMES
 * the variable and lists the valid roles. Fail-safe: an unset or unknown role never silently boots
 * the wrong process (or the old no-op scaffold).
 */
export function resolveServiceRole(env: Record<string, string | undefined>): ServiceRole {
  const raw = env.SERVICE_ROLE?.trim();
  if (!isServiceRole(raw)) {
    throw new ConfigError(
      ['SERVICE_ROLE'],
      `${CONFIG_ERROR_CODE}: SERVICE_ROLE must be one of ${SERVICE_ROLES.join(', ')} — ${
        raw ? `got '${raw}'` : 'it is unset'
      }`,
    );
  }
  return raw;
}
