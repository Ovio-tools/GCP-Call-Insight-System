import { errorCodeSchema } from './categories.js';
import { type FailureFields, sanitizeContext } from './error.js';

/**
 * Scope keys in fixed priority order. The most specific present key becomes the dedup
 * scope, so repeated identical failures for the same call/job collapse to one alert while
 * distinct subjects stay distinct.
 */
export const DEDUP_SCOPE_PRIORITY = [
  'call_id',
  'job_id',
  'component',
  'stage',
  'environment',
] as const;

/**
 * A deterministic dedup key so repeated identical failures collapse to one alert during an
 * incident (matching the `alert_events` partial unique index on `dedup_key`).
 *
 * Validates the code and sanitizes context internally first — the `FailureFields` *type*
 * cannot guarantee a hand-built value is safe — so a content-like `error_code` throws rather
 * than leaking, and unsafe/unknown/content context keys never reach the key. The scope value
 * is a raw identifier (consistent with `call_id` being a safe system identifier and with the
 * worker shim's `dead_letter:${callId}`), never a timestamp.
 */
export function dedupKey(error: FailureFields): string {
  const code = errorCodeSchema.parse(error.error_code);
  const context = sanitizeContext(error.context);

  for (const key of DEDUP_SCOPE_PRIORITY) {
    const value = context[key];
    if (value !== undefined) {
      return `${code}:${key}:${value}`;
    }
  }
  return `${code}:global`;
}
