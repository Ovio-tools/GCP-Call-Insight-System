import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type RawWebhookEventInsert,
  type RawWebhookEventRow,
  rawWebhookEventInsertSchema,
  rawWebhookEventRowSchema,
} from '../schemas/raw-webhook-events.js';

const TABLE = 'raw_webhook_events';

/** Store a minimized webhook event (allowlisted metadata only). Append-only ingest row. */
export async function insertWebhookEvent(
  pool: Pool,
  input: RawWebhookEventInsert,
): Promise<RawWebhookEventRow> {
  const v = parseOrThrow(TABLE, rawWebhookEventInsertSchema, input);
  const rows = await query<RawWebhookEventRow>(
    pool,
    `INSERT INTO raw_webhook_events (source, payload, signature_status, received_at, retention_eligible_at)
     VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), $3, COALESCE($4::timestamptz, now()), $5::timestamptz)
     RETURNING *`,
    [
      v.source,
      toJsonParam(v.payload),
      v.signatureStatus,
      v.receivedAt ?? null,
      v.retentionEligibleAt ?? null,
    ],
  );
  return parseOrThrow(TABLE, rawWebhookEventRowSchema, rows[0]);
}

export async function getWebhookEvent(
  pool: Pool,
  id: string,
): Promise<RawWebhookEventRow | undefined> {
  const rows = await query<RawWebhookEventRow>(
    pool,
    `SELECT * FROM raw_webhook_events
      WHERE id = $1 AND soft_deleted_at IS NULL AND hard_deleted_at IS NULL`,
    [id],
  );
  return rows[0] ? parseOrThrow(TABLE, rawWebhookEventRowSchema, rows[0]) : undefined;
}
