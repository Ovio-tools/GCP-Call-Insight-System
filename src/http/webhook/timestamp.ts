/**
 * Freshness check for signed webhooks. Rejects timestamps that are too old (a captured
 * request being replayed) or too far in the future (a forged/mis-clocked sender), bounding
 * how long a valid-but-stale signature remains usable.
 */

/**
 * True if `timestampMs` is within `skewMs` of `nowMs` in EITHER direction. A non-finite
 * timestamp (failed extraction) is always rejected.
 */
export function isTimestampFresh(timestampMs: number, nowMs: number, skewMs: number): boolean {
  if (!Number.isFinite(timestampMs)) {
    return false;
  }
  return Math.abs(nowMs - timestampMs) <= skewMs;
}
