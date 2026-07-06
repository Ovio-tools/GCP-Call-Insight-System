import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { registerKnowledgeRoutes } from '../../src/knowledge/routes.js';
import type { Config } from '../../src/config/schema.js';
import { repositories } from '../../src/db/index.js';
import { makeTestConfig } from '../_config.js';
import { makeInternalApp, type InternalHarness } from '../http/_helpers.js';

const silentLogger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/**
 * Build an internal app with the knowledge routes mounted. The SAME config overrides feed both the
 * internal app (built inside `makeInternalApp`) and the route registrar, so page-size / export caps
 * agree. `denyTerms` drives the value-level residual egress guard.
 */
export async function makeKnowledgeHarness(
  pool: Pool,
  opts: { denyTerms?: readonly string[]; config?: Partial<Config> } = {},
): Promise<InternalHarness> {
  const overrides = opts.config ?? {};
  const config = makeTestConfig(overrides);
  return makeInternalApp(overrides, undefined, (app) => {
    registerKnowledgeRoutes(app, {
      pool,
      config,
      denyTerms: opts.denyTerms ?? [],
      logger: silentLogger,
    });
  });
}

export interface SeedKnowledgeRow {
  callId: string;
  createdAt: string;
  serviceCategory?: string;
  callIntent?: string;
  urgency?: string;
  problemStatement?: string | null;
  symptoms?: string[];
  customerLanguage?: string[];
  concerns?: string[];
  competitorMentions?: string[];
  acquisitionSource?: string | null;
  locationInHome?: string | null;
  accessOrSchedulingNotes?: string | null;
  priorAttempts?: string | null;
}

/** Insert one structured_knowledge row (owner pool) with its FK call_state seeded (app pool). */
export async function seedKnowledge(owner: Pool, app: Pool, row: SeedKnowledgeRow): Promise<void> {
  await repositories.callState.upsertCallState(app, {
    callId: row.callId,
    source: 'test',
    currentStage: 'store',
    status: 'completed',
  });
  await owner.query(
    `INSERT INTO structured_knowledge (
       call_id, call_intent, service_category, problem_statement, symptoms, customer_language,
       location_in_home, access_or_scheduling_notes, prior_attempts, urgency, concerns,
       sentiment, acquisition_source, competitor_mentions, schema_version, prompt_version, model_id,
       created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,'neutral',$12,$13::jsonb,1,'v1','m1',$14)`,
    [
      row.callId,
      row.callIntent ?? 'new_booking',
      row.serviceCategory ?? 'water_heater',
      row.problemStatement ?? null,
      JSON.stringify(row.symptoms ?? []),
      JSON.stringify(row.customerLanguage ?? []),
      row.locationInHome ?? null,
      row.accessOrSchedulingNotes ?? null,
      row.priorAttempts ?? null,
      row.urgency ?? 'routine',
      JSON.stringify(row.concerns ?? []),
      row.acquisitionSource ?? null,
      JSON.stringify(row.competitorMentions ?? []),
      row.createdAt,
    ],
  );
}
