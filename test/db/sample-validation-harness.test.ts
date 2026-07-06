import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import { hasTestDb, makePool } from './_pg.js';
import { makeAppPool } from './_dal.js';
import { makeTestConfig } from '../_config.js';
import { recordConsent } from '../../src/db/repositories/consent-gates-repo.js';
import { upsertCleanTranscript } from '../../src/db/repositories/clean-transcripts-repo.js';
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
  runSampleValidation,
  SampleValidationError,
} from '../../src/sample-validation/index.js';

const logger = pino({ level: 'silent' });

/** A recording no-op pipeline runner — proves orchestration without touching Dialpad/Anthropic. */
function recordingRunner() {
  const calls: string[] = [];
  const run = (_pool: Pool, callId: string): Promise<void> => {
    calls.push(callId);
    return Promise.resolve();
  };
  return { calls, run };
}

describe.skipIf(!hasTestDb)('sample-validation harness orchestration (Task 11.1)', () => {
  let owner!: Pool;
  let app!: Pool;

  const CALLS = ['sv-h-1', 'sv-h-2'];
  const ALL_GATE_TYPES = [...REQUIRED_PROCESSING_GATE_TYPES, SERVICETITAN_MATCHING_CONSENT_GATE];

  function stagingConfig(overrides = {}) {
    return makeTestConfig({
      NODE_ENV: 'staging',
      DATABASE_URL: 'postgres://u:pw@db.staging.internal:5432/app',
      REDIS_URL: 'redis://redis.staging.internal:6379',
      ...overrides,
    });
  }

  async function recordProcessingGates(): Promise<void> {
    for (const gateType of REQUIRED_PROCESSING_GATE_TYPES) {
      await recordConsent(owner, { gateType, recordedBy: 'harness-test', evidenceRef: 'r' });
    }
  }

  async function seedProcessedCalls(): Promise<void> {
    for (const callId of CALLS) {
      await owner.query(
        `INSERT INTO call_state (call_id, source, current_stage, status)
         VALUES ($1, 'test', 'mark-retention-eligible', 'completed') ON CONFLICT (call_id) DO NOTHING`,
        [callId],
      );
      await upsertCleanTranscript(app, {
        callId,
        redactedText: `Redacted transcript for ${callId}`,
        redactionRiskScore: 0.05,
        redactionReasons: [],
      });
    }
  }

  async function cleanup(): Promise<void> {
    await owner.query(`DELETE FROM consent_gates WHERE gate_type = ANY($1)`, [ALL_GATE_TYPES]);
    for (const callId of CALLS) {
      await owner.query(`DELETE FROM clean_transcripts WHERE call_id = $1`, [callId]);
      await owner.query(`DELETE FROM call_state WHERE call_id = $1`, [callId]);
    }
  }

  beforeAll(() => {
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await owner.end();
    await app.end();
  });

  it('refuses outside staging before any side effect', async () => {
    const runner = recordingRunner();
    await expect(
      runSampleValidation(
        app,
        makeTestConfig({ NODE_ENV: 'production' }),
        {
          selection: { callIds: CALLS },
        },
        { runCall: runner.run, denyTerms: [], logger },
      ),
    ).rejects.toMatchObject({ reason: 'not_staging' });
    expect(runner.calls).toEqual([]);
  });

  it('refuses a production database before any side effect, even with gates present', async () => {
    await recordProcessingGates();
    const runner = recordingRunner();
    await expect(
      runSampleValidation(
        app,
        stagingConfig({ DATABASE_URL: 'postgres://u:pw@db.prod.internal:5432/app' }),
        { selection: { callIds: CALLS } },
        { runCall: runner.run, denyTerms: [], logger },
      ),
    ).rejects.toMatchObject({ reason: 'production_resource' });
    expect(runner.calls).toEqual([]);
  });

  it('blocks before any pipeline run when a required processing gate is missing', async () => {
    const runner = recordingRunner();
    await expect(
      runSampleValidation(
        app,
        stagingConfig(),
        { selection: { callIds: CALLS } },
        {
          runCall: runner.run,
          denyTerms: [],
          logger,
        },
      ),
    ).rejects.toMatchObject({ reason: 'missing_consent_gates' });
    expect(runner.calls).toEqual([]);
  });

  it('runs the full pipeline per selected call and builds PII-free reports when gates are present', async () => {
    await recordProcessingGates();
    await seedProcessedCalls();
    const runner = recordingRunner();

    const result = await runSampleValidation(
      app,
      stagingConfig(),
      { selection: { callIds: CALLS } },
      {
        runCall: runner.run,
        denyTerms: [],
        logger,
        now: new Date(0),
      },
    );

    expect(runner.calls).toEqual(CALLS);
    expect(result.callIds).toEqual(CALLS);
    expect(result.reports.map((r) => r.call_id)).toEqual(CALLS);
    expect(result.reports[0]!.redacted_text).toContain('Redacted transcript for sv-h-1');
    expect(result.serviceTitanExercised).toBe(false);
  });

  it('requires the ServiceTitan matching consent only when the run exercises that path', async () => {
    await recordProcessingGates();
    await seedProcessedCalls();

    // Exercising ServiceTitan without its consent → blocked.
    const blockedRunner = recordingRunner();
    await expect(
      runSampleValidation(
        app,
        stagingConfig(),
        { selection: { callIds: CALLS }, exercisesServiceTitan: true },
        { runCall: blockedRunner.run, denyTerms: [], logger },
      ),
    ).rejects.toMatchObject({ reason: 'missing_consent_gates' });
    expect(blockedRunner.calls).toEqual([]);

    // Same gates, NOT exercising ServiceTitan → allowed.
    const okRunner = recordingRunner();
    const result = await runSampleValidation(
      app,
      stagingConfig(),
      { selection: { callIds: CALLS }, exercisesServiceTitan: false },
      { runCall: okRunner.run, denyTerms: [], logger, now: new Date(0) },
    );
    expect(okRunner.calls).toEqual(CALLS);

    // Record the consent → exercising ServiceTitan is now allowed.
    await recordConsent(owner, {
      gateType: SERVICETITAN_MATCHING_CONSENT_GATE,
      recordedBy: 'harness-test',
      evidenceRef: 'r',
    });
    const stRunner = recordingRunner();
    await runSampleValidation(
      app,
      stagingConfig(),
      { selection: { callIds: CALLS }, exercisesServiceTitan: true },
      { runCall: stRunner.run, denyTerms: [], logger, now: new Date(0) },
    );
    expect(stRunner.calls).toEqual(CALLS);
    expect(result.serviceTitanExercised).toBe(false);
  });

  it('resolves a sample size to call ids via the injected selector', async () => {
    await recordProcessingGates();
    await seedProcessedCalls();
    const runner = recordingRunner();

    const result = await runSampleValidation(
      app,
      stagingConfig(),
      { selection: { sampleSize: 2 } },
      {
        runCall: runner.run,
        denyTerms: [],
        logger,
        now: new Date(0),
        selectCallIds: () => Promise.resolve(CALLS),
      },
    );

    expect(result.callIds).toEqual(CALLS);
    expect(runner.calls).toEqual(CALLS);
  });

  it('refuses an over-cap selection before touching gates or the pipeline', async () => {
    const runner = recordingRunner();
    let caught: unknown;
    try {
      await runSampleValidation(
        app,
        stagingConfig(),
        { selection: { sampleSize: 9999 } },
        {
          runCall: runner.run,
          denyTerms: [],
          logger,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SampleValidationError);
    expect((caught as SampleValidationError).reason).toBe('invalid_sample_selection');
    expect(runner.calls).toEqual([]);
  });
});
