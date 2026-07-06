import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import { query } from '../db/sql.js';
import {
  assertNoProductionResources,
  assertStagingEnvironment,
  type ResourceEndpoint,
} from './guards.js';
import { resolveSampleSelection, type SampleSelectionInput } from './selection.js';
import { assertProcessingGates } from './gates.js';
import { buildSampleReport, type SampleReportEntry } from './report.js';

/**
 * The sample-validation harness orchestrator (Task 11.1).
 *
 * The single entrypoint that enforces the §0.2 exception end to end, in an order that guarantees
 * NOTHING happens until every gate clears:
 *   1. staging-only (refuse production / any non-staging env, even with credentials);
 *   2. no production database / queue / service endpoint (defense-in-depth host screen);
 *   3. bounded selection (an explicit call-id list or a capped sample size — pure, no side effects);
 *   4. every §0.2 processing gate recorded (plus the conditional ServiceTitan matching consent);
 *   5. ONLY THEN run the real pipeline per call and build a PII-free side-by-side report.
 *
 * The pipeline itself is injected (`runCall`) so the harness reuses the FULL existing per-call state
 * machine rather than duplicating stage logic; the production runner drives `runPipeline`, and tests
 * inject a synthetic runner so no live Dialpad/Anthropic call is ever made. The harness writes
 * nothing itself — reads for the report, delegates processing to `runCall`.
 */

/** Runs one already-seeded call through the full pipeline. Production: wraps `runPipeline`. */
export type PipelineRunner = (pool: Pool, callId: string, logger: Logger) => Promise<void>;

export interface SampleValidationInput {
  selection: SampleSelectionInput;
  /** True when this run exercises ServiceTitan / match-key behavior (gates the matching consent). */
  exercisesServiceTitan?: boolean;
}

export interface SampleValidationDeps {
  runCall: PipelineRunner;
  denyTerms: readonly string[];
  logger: Logger;
  now?: Date;
  /** Extra production-marker screen terms (defaults to the conservative built-in list). */
  productionMarkers?: readonly string[];
  /** Lower the conservative sample-size cap. */
  maxSampleSize?: number;
  /** Extra service endpoints to screen for a production host (beyond the config's own). */
  resourceEndpoints?: readonly ResourceEndpoint[];
  /** Resolve a sample size to concrete call ids. Defaults to the most recent processed calls. */
  selectCallIds?: (pool: Pool, sampleSize: number) => Promise<string[]>;
}

export interface SampleValidationRunResult {
  environment: Config['NODE_ENV'];
  serviceTitanExercised: boolean;
  callIds: string[];
  reports: SampleReportEntry[];
}

/** Default sample-size resolver: the most recent `call_state` rows, newest first. */
async function selectRecentCallIds(pool: Pool, sampleSize: number): Promise<string[]> {
  const rows = await query<{ call_id: string }>(
    pool,
    `SELECT call_id FROM call_state ORDER BY created_at DESC, call_id DESC LIMIT $1`,
    [sampleSize],
  );
  return rows.map((r) => r.call_id);
}

export async function runSampleValidation(
  pool: Pool,
  config: Config,
  input: SampleValidationInput,
  deps: SampleValidationDeps,
): Promise<SampleValidationRunResult> {
  // 1 + 2 — environment and resource guards. Refuse before ANY DB read or pipeline call.
  assertStagingEnvironment(config);
  assertNoProductionResources(
    {
      databaseUrl: config.DATABASE_URL,
      queueUrl: config.REDIS_URL,
      endpoints: [
        { label: 'dialpad', url: config.DIALPAD_BASE_URL },
        { label: 'oidc', url: config.OIDC_ISSUER_URL },
        ...(deps.resourceEndpoints ?? []),
      ],
    },
    { productionMarkers: deps.productionMarkers },
  );

  // 3 — bounded selection (pure, no side effects).
  const selection = resolveSampleSelection(input.selection, { maxSampleSize: deps.maxSampleSize });

  // 4 — every required §0.2 gate must be recorded. Blocks BEFORE any pipeline run or report write.
  const serviceTitanExercised = input.exercisesServiceTitan ?? false;
  await assertProcessingGates(pool, { requireServiceTitanMatching: serviceTitanExercised });

  // 5 — resolve the concrete batch, then run the full pipeline per call and build reports.
  const selectCallIds = deps.selectCallIds ?? selectRecentCallIds;
  const callIds =
    selection.mode === 'call_ids'
      ? [...selection.callIds]
      : await selectCallIds(pool, selection.sampleSize);

  const reports: SampleReportEntry[] = [];
  for (const callId of callIds) {
    await deps.runCall(pool, callId, deps.logger);
    reports.push(
      await buildSampleReport(pool, callId, {
        denyTerms: deps.denyTerms,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      }),
    );
  }

  return { environment: config.NODE_ENV, serviceTitanExercised, callIds, reports };
}
