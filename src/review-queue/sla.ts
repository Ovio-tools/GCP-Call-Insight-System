import type { Config } from '../config/schema.js';
import type { HeldReason } from '../db/enums.js';

/**
 * The review SLA (minutes) for a held call, looked up from the validated config map.
 *
 * Startup validation (`REVIEW_SLA_MINUTES_BY_REASON` in `config/schema.ts`) guarantees the
 * map is total over every `HELD_REASON`, so this is a pure lookup. The defensive
 * `undefined` guard exists only so a corrupted/hand-built config surfaces loudly instead of
 * silently seeding a `NaN` SLA — it should be unreachable after boot validation.
 */
export function slaMinutesFor(config: Config, heldReason: HeldReason): number {
  const minutes = config.REVIEW_SLA_MINUTES_BY_REASON[heldReason];
  if (minutes === undefined) {
    throw new Error(`no review SLA configured for held_reason '${heldReason}'`);
  }
  return minutes;
}
