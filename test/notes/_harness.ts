import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { registerNotesRoutes } from '../../src/notes/routes.js';
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
 * Build an internal app with the note-review routes mounted. The SAME config overrides feed both
 * the internal app (built inside `makeInternalApp`) and the route registrar, so the page-size
 * bounds agree — the knowledge harness does this for the same reason. `denyTerms` drives the
 * value-level residual egress guard on the note fields and the transcript.
 *
 * `logger` here is intentionally silent: the tests that care about log CONTENT assert against
 * `harness.lines`, which is the app-level capturing logger `makeInternalApp` installs.
 */
export async function makeNotesHarness(
  pool: Pool,
  opts: { denyTerms?: readonly string[]; config?: Partial<Config> } = {},
): Promise<InternalHarness> {
  const overrides = opts.config ?? {};
  const config = makeTestConfig(overrides);
  return makeInternalApp(overrides, undefined, (app) => {
    registerNotesRoutes(app, {
      pool,
      config,
      denyTerms: opts.denyTerms ?? [],
      logger: silentLogger,
    });
  });
}

export interface SeedNoteRow {
  callId: string;
  createdAt: string;
  serviceCategory?: string;
  urgency?: string;
  promptVersion?: string;
  scopeSignal?: string;
  occupancy?: string;
  equipment?: Record<string, string | null>;
  systemContext?: Record<string, string | null>;
  waterStatus?: Record<string, boolean | null>;
  payerAuthority?: Record<string, boolean | null>;
  priorWork?: Record<string, boolean | null>;
  commitmentsMade?: Record<string, boolean | null>;
  locationOnProperty?: string | null;
  symptomVerbatim?: string | null;
  priorAttemptsDetail?: string | null;
  accessNotes?: string | null;
  hazards?: string[];
  urgencyContext?: string[];
  notEstablished?: string[];
  dispatchSummary?: string | null;
}

const ALL_NULL = <T>(keys: readonly string[]): Record<string, T | null> =>
  Object.fromEntries(keys.map((k) => [k, null]));

/**
 * Seed the full chain a note needs: `call_state` (FK parent, via the app pool DAL) →
 * `structured_knowledge` (the note surface JOINs it for category/urgency/date) → `technician_notes`.
 *
 * Content rows go in on the OWNER pool: `app_role` has no INSERT on some tables and no DELETE
 * anywhere, so setup/teardown runs as owner while the routes under test read as `app_role`.
 */
export async function seedNote(owner: Pool, app: Pool, row: SeedNoteRow): Promise<void> {
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
     VALUES ($1,'new_booking',$2,null,'[]'::jsonb,'[]'::jsonb,null,null,null,$3,'[]'::jsonb,
             'neutral',null,'[]'::jsonb,1,'v1','m1',$4)`,
    [row.callId, row.serviceCategory ?? 'water_heater', row.urgency ?? 'routine', row.createdAt],
  );
  await owner.query(
    `INSERT INTO technician_notes (
       call_id, prompt_version, model_id, schema_version, scope_signal,
       equipment, system_context, water_status, payer_authority, prior_work,
       location_on_property, symptom_verbatim, prior_attempts_detail, access_notes,
       hazards, urgency_context, commitments_made, occupancy, not_established, dispatch_summary)
     VALUES ($1,$2,'m1',1,$3,
             $4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,
             $9,$10,$11,$12,
             $13::jsonb,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18)`,
    [
      row.callId,
      row.promptVersion ?? 'tech-note-v1',
      row.scopeSignal ?? 'single_fixture',
      JSON.stringify(
        row.equipment ??
          ALL_NULL(['type', 'brand', 'model', 'capacity', 'approximate_age', 'fuel_type']),
      ),
      JSON.stringify(
        row.systemContext ??
          ALL_NULL(['waste_system', 'water_source', 'foundation_type', 'property_age']),
      ),
      JSON.stringify(
        row.waterStatus ??
          ALL_NULL([
            'actively_running',
            'supply_shut_off',
            'shutoff_location_known',
            'active_damage',
          ]),
      ),
      JSON.stringify(
        row.payerAuthority ??
          ALL_NULL(['can_approve_work', 'home_warranty', 'insurance_claim', 'third_party_payer']),
      ),
      JSON.stringify(
        row.priorWork ?? ALL_NULL(['is_repeat_visit', 'is_warranty_claim', 'prior_work_by_others']),
      ),
      row.locationOnProperty ?? null,
      row.symptomVerbatim ?? null,
      row.priorAttemptsDetail ?? null,
      row.accessNotes ?? null,
      JSON.stringify(row.hazards ?? []),
      JSON.stringify(row.urgencyContext ?? []),
      JSON.stringify(
        row.commitmentsMade ??
          ALL_NULL([
            'price_quoted',
            'dispatch_fee_mentioned',
            'arrival_window_given',
            'technician_named',
            'scope_described',
          ]),
      ),
      row.occupancy ?? 'owner',
      JSON.stringify(row.notEstablished ?? []),
      row.dispatchSummary ?? null,
    ],
  );
}

/** Insert a clean transcript for a call. `softDeleted` exercises the retention path the transcript
 * route must report as `unavailable` rather than as an error. */
export async function seedCleanTranscript(
  owner: Pool,
  callId: string,
  redactedText: string,
  opts: { softDeleted?: boolean; hardDeleted?: boolean } = {},
): Promise<void> {
  await owner.query(
    `INSERT INTO clean_transcripts (call_id, redacted_text, redaction_risk_score, redaction_reasons,
                                    soft_deleted_at, hard_deleted_at)
     VALUES ($1, $2, 0.1, '[]'::jsonb, $3, $4)`,
    [
      callId,
      redactedText,
      opts.softDeleted ? new Date() : null,
      opts.hardDeleted ? new Date() : null,
    ],
  );
}

/** POST a verdict with the CSRF header the shared middleware requires. */
export async function postFeedback(
  harness: InternalHarness,
  session: { cookie: string; csrfToken: string },
  callId: string,
  body: unknown,
): Promise<{ status: number; json: <T>() => T; body: string }> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/notes/${encodeURIComponent(callId)}/feedback`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, json: <T>() => res.json<T>(), body: res.body };
}
