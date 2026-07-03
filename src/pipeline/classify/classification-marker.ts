import type { Pool } from 'pg';
import { z } from 'zod';
import { CLASSIFY_BUCKETS } from '../../anthropic/client.js';
import { query } from '../../db/sql.js';
import type { ClassifyBucket } from './parse.js';

/**
 * Reader for the classify stage's audit marker — the ONLY consumer of the shape the
 * state-machine writes onto classify's `outcome:'completed'` processing_log row.
 *
 * The classify handler returns `{action:'continue', detail:{bucket:'customer'}}`; the
 * runner (src/pipeline/state-machine.ts) records that `detail` on the completed row.
 * This helper owns knowledge of that shape so the extract handler's classification guard
 * has a single, typed place to consult. A shape-pinning test in the classify suite breaks
 * classify's OWN CI if the `detail` shape ever drifts.
 *
 * Re-exported here (not redefined) so callers importing the reader also get the tuple type.
 */
export type { ClassifyBucket } from './parse.js';

/** Bucket-only validator: never trust the stored column blindly (matches the wire enum). */
const bucketSchema = z.enum(CLASSIFY_BUCKETS);

/**
 * The latest classify bucket recorded for this call, or `undefined` when there is no
 * completed classify row (or the stored value is not a valid bucket — a corrupt/legacy
 * row must never be trusted as a real classification). A single indexed read of the newest
 * `stage='classify' AND outcome='completed'` processing_log row; the `created_at DESC,
 * id DESC` tie-break mirrors `parkStageDisabled` in ../model-stage-shared.ts.
 */
export async function getLatestClassificationBucket(
  pool: Pool,
  callId: string,
): Promise<ClassifyBucket | undefined> {
  const rows = await query<{ bucket: string | null }>(
    pool,
    `SELECT detail->>'bucket' AS bucket
       FROM processing_log
      WHERE call_id = $1 AND stage = 'classify' AND outcome = 'completed'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [callId],
  );
  const raw = rows[0]?.bucket;
  if (raw == null) return undefined;
  const parsed = bucketSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
