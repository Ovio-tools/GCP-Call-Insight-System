import { z } from 'zod';
import type { RecentCall } from '../dialpad/client/index.js';
import { BackfillError } from './errors.js';

/**
 * The resumable backfill checkpoint (Task 11.2, §3), stored as JSON in the existing
 * `backfill_runs.last_checkpoint` text column (no schema change). The scan/watermark axis is
 * `startedAt` (what `started_after` pages by); `watermarkStartedAtMs` is the OLDEST fully-ingested
 * `startedAt` so far (newest-first scan). The counters are progress metadata only.
 */
export const backfillCheckpointSchema = z.object({
  v: z.literal(1),
  phase: z.enum(['sweep', 'drain']),
  watermarkStartedAtMs: z.number().nullable(),
  callsSeen: z.number().int().nonnegative(),
  seededTotal: z.number().int().nonnegative(),
  terminalCount: z.number().int().nonnegative(),
});
export type BackfillCheckpoint = z.infer<typeof backfillCheckpointSchema>;

/** Serialize a checkpoint for the `last_checkpoint` column. */
export function encodeCheckpoint(cp: BackfillCheckpoint): string {
  return JSON.stringify(cp);
}

/**
 * Parse a stored checkpoint (fail-closed, R1 #7). `null` → undefined (no checkpoint yet). Malformed
 * JSON or a wrong shape → `BackfillError('invalid_checkpoint')` (ids/phase only, never content), so
 * a corrupt checkpoint refuses to run rather than silently resetting the watermark.
 */
export function decodeCheckpoint(raw: string | null): BackfillCheckpoint | undefined {
  if (raw === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BackfillError(
      'invalid_checkpoint',
      'refusing to resume: checkpoint JSON is malformed',
    );
  }
  const parsed = backfillCheckpointSchema.safeParse(json);
  if (!parsed.success) {
    throw new BackfillError(
      'invalid_checkpoint',
      'refusing to resume: checkpoint has an unrecognised shape',
    );
  }
  return parsed.data;
}

/**
 * Boundary-safe resume decision (R1 #3). On resume the scan restarts from the top (newest-first) and
 * SKIPS any call STRICTLY newer than the watermark (already ingested), while a call at EXACTLY the
 * watermark timestamp is re-ingested (idempotent seed + call_id-keyed job → no gap, no duplicate).
 * A `null` watermark (nothing ingested yet) skips nothing.
 */
export function shouldSkip(startedAtMs: number, watermarkStartedAtMs: number | null): boolean {
  if (watermarkStartedAtMs === null) return false;
  return startedAtMs > watermarkStartedAtMs;
}

/**
 * Advance the watermark to the OLDEST fully-ingested `startedAt` after a page (newest-first, so each
 * page is older than the last). The watermark only ever moves DOWN: `min(prior ?? +∞, min(page))`.
 * Called ONLY for a page whose every item had a valid `startedAt` (see {@link pageStartedAtFailure}).
 */
export function advanceWatermark(
  current: number | null | undefined,
  pageStartedAtMs: readonly number[],
): number {
  const pageMin = Math.min(...pageStartedAtMs);
  if (current === null || current === undefined) return pageMin;
  return Math.min(current, pageMin);
}

/**
 * Fail-closed startedAt validation for a page (R2 #3). Returns the id of the FIRST listed item with
 * no parseable `startedAt`, or undefined when every item has one. The orchestrator throws
 * `missing_started_at` on a non-undefined result BEFORE checkpointing that page, so the watermark
 * never advances over an unorderable page.
 */
export function pageStartedAtFailure(calls: readonly RecentCall[]): string | undefined {
  for (const call of calls) {
    if (call.startedAt === undefined) return call.callId;
  }
  return undefined;
}
