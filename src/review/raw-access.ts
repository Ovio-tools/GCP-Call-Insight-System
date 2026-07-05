import type { Config } from '../config/schema.js';

/** The review-row fields the raw-access predicates read. */
export interface RawAccessReview {
  raw_purged_at: Date | null;
  created_at: Date;
}

type CapConfig = Pick<Config, 'REVIEW_HELD_RAW_RETENTION_CAP_HOURS'>;

/**
 * Whether the raw-transcript retention WINDOW is still open for a held call (Task 6.2, plan
 * §"Shared raw-access predicates"): the raw has not been cap-purged AND `now` is still within
 * `created_at + REVIEW_HELD_RAW_RETENTION_CAP_HOURS`. The cap is a TIME limit, so a lagging
 * retention cron can leave a past-cap review with `raw_purged_at` still null; re-pulling raw then
 * would reintroduce raw PII after the cap — hence the explicit time check, not just the purge
 * flag.
 *
 * Used ALONE by the `fetch-transcript` reprocess preflight (fetching a not-yet-present transcript
 * is the point — do NOT also require the transcript to already exist).
 */
export function rawRetentionWindowOpen(
  review: RawAccessReview,
  now: Date,
  config: CapConfig,
): boolean {
  if (review.raw_purged_at !== null) return false;
  const capMs = config.REVIEW_HELD_RAW_RETENTION_CAP_HOURS * 3_600_000;
  return now.getTime() < review.created_at.getTime() + capMs;
}

/**
 * Whether a raw transcript may be revealed / re-consumed for a held call: the retention window is
 * open AND a live transcript actually exists (`transcriptPresent`, computed by the caller via the
 * no-decrypt `transcriptExists`). Used by the detail `raw_available` flag, `/reveal-raw`, and the
 * `transcript-availability` / `redact` reprocess preflights — one source of truth, no drift.
 */
export function rawTranscriptRevealAllowed(
  review: RawAccessReview,
  now: Date,
  config: CapConfig,
  transcriptPresent: boolean,
): boolean {
  return rawRetentionWindowOpen(review, now, config) && transcriptPresent;
}
