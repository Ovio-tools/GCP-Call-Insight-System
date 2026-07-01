import type { Pool } from 'pg';
import { parseOrThrow } from '../errors.js';
import { query, toJsonParam } from '../sql.js';
import {
  type StructuredKnowledgeInsert,
  type StructuredKnowledgeRow,
  structuredKnowledgeInsertSchema,
  structuredKnowledgeRowSchema,
} from '../schemas/structured-knowledge.js';

const TABLE = 'structured_knowledge';

/** Idempotent upsert keyed on call_id — the durable extracted record for a call. */
export async function upsertStructuredKnowledge(
  pool: Pool,
  input: StructuredKnowledgeInsert,
): Promise<StructuredKnowledgeRow> {
  const v = parseOrThrow(TABLE, structuredKnowledgeInsertSchema, input);
  const rows = await query<StructuredKnowledgeRow>(
    pool,
    `INSERT INTO structured_knowledge (
       call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
       location_in_home, access_or_scheduling_notes, prior_attempts, urgency, concerns,
       sentiment, acquisition_source, competitor_mentions, schema_version, prompt_version, model_id)
     VALUES (
       $1, $2, $3, $4, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6::jsonb, '[]'::jsonb),
       $7, $8, $9, $10, COALESCE($11::jsonb, '[]'::jsonb),
       $12, $13, COALESCE($14::jsonb, '[]'::jsonb), $15, $16, $17)
     ON CONFLICT (call_id) DO UPDATE SET
       call_intent = EXCLUDED.call_intent,
       service_category = EXCLUDED.service_category,
       problem_statement = EXCLUDED.problem_statement,
       symptoms = EXCLUDED.symptoms,
       customer_language = EXCLUDED.customer_language,
       location_in_home = EXCLUDED.location_in_home,
       access_or_scheduling_notes = EXCLUDED.access_or_scheduling_notes,
       prior_attempts = EXCLUDED.prior_attempts,
       urgency = EXCLUDED.urgency,
       concerns = EXCLUDED.concerns,
       sentiment = EXCLUDED.sentiment,
       acquisition_source = EXCLUDED.acquisition_source,
       competitor_mentions = EXCLUDED.competitor_mentions,
       schema_version = EXCLUDED.schema_version,
       prompt_version = EXCLUDED.prompt_version,
       model_id = EXCLUDED.model_id
     RETURNING *`,
    [
      v.callId,
      v.callIntent,
      v.serviceCategory,
      v.problemStatement ?? null,
      toJsonParam(v.symptoms),
      toJsonParam(v.customerLanguage),
      v.locationInHome ?? null,
      v.accessOrSchedulingNotes ?? null,
      v.priorAttempts ?? null,
      v.urgency,
      toJsonParam(v.concerns),
      v.sentiment,
      v.acquisitionSource ?? null,
      toJsonParam(v.competitorMentions),
      v.schemaVersion,
      v.promptVersion,
      v.modelId,
    ],
  );
  return parseOrThrow(TABLE, structuredKnowledgeRowSchema, rows[0]);
}

export async function getStructuredKnowledge(
  pool: Pool,
  callId: string,
): Promise<StructuredKnowledgeRow | undefined> {
  const rows = await query<StructuredKnowledgeRow>(
    pool,
    `SELECT * FROM structured_knowledge WHERE call_id = $1`,
    [callId],
  );
  return rows[0] ? parseOrThrow(TABLE, structuredKnowledgeRowSchema, rows[0]) : undefined;
}
