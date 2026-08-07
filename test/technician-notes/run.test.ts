import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { upsertCallState } from '../../src/db/repositories/call-state-repo.js';
import {
  softDeleteCleanTranscript,
  upsertCleanTranscript,
} from '../../src/db/repositories/clean-transcripts-repo.js';
import {
  countNonDispatchableCandidates,
  listNoteCandidateCallIds,
  upsertTechnicianNote,
} from '../../src/db/repositories/technician-notes-repo.js';
import type { CallIntent, ServiceCategory } from '../../src/db/enums.js';
import {
  setStructuredKnowledgeSuperseded,
  upsertStructuredKnowledge,
} from '../../src/db/repositories/structured-knowledge-repo.js';
import type { BackfillMonitor } from '../../src/heartbeat/index.js';
import { createRootLogger } from '../../src/logging/logger.js';
import {
  TECHNICIAN_NOTE_PROMPT_VERSION,
  TechnicianNoteError,
  type NoteGenerationResult,
  type TechnicianNoteGenerator,
  runTechnicianNotes,
} from '../../src/technician-notes/index.js';
import { makeTestConfig } from '../_config.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

const PATTERN = 'test-noterun-%';

function fakeMonitor(): { monitor: BackfillMonitor; events: string[] } {
  const events: string[] = [];
  return {
    events,
    monitor: {
      start: () => {
        events.push('start');
        return Promise.resolve();
      },
      recordProgress: (counts) => events.push(`progress:${JSON.stringify(counts)}`),
      success: () => {
        events.push('success');
        return Promise.resolve();
      },
      fail: () => {
        events.push('fail');
        return Promise.resolve();
      },
      stop: () => events.push('stop'),
    },
  };
}

describe.skipIf(!hasTestDb)('technician-note batch runner', () => {
  let owner!: Pool;
  let app!: Pool;
  const logger = createRootLogger({ level: 'silent' });

  const seed = async (
    callId: string,
    opts: { transcript?: boolean; callIntent?: CallIntent; serviceCategory?: ServiceCategory } = {},
  ): Promise<void> => {
    await upsertCallState(app, {
      callId,
      source: 'test',
      currentStage: 'mark-retention-eligible',
      status: 'completed',
    });
    if (opts.transcript !== false) {
      await upsertCleanTranscript(app, {
        callId,
        redactedText: 'Caller: the sink is blocked',
        redactionRiskScore: 0.1,
      });
    }
    await upsertStructuredKnowledge(app, {
      callId,
      callIntent: opts.callIntent ?? 'new_booking',
      serviceCategory: opts.serviceCategory ?? 'drain_blockage',
      urgency: 'routine',
      sentiment: 'neutral',
      schemaVersion: 1,
      promptVersion: 'extract-v3',
      modelId: 'test-model',
    });
  };

  const seedNote = async (callId: string, promptVersion: string): Promise<void> => {
    await upsertTechnicianNote(app, {
      callId,
      promptVersion,
      modelId: 'test-model',
      schemaVersion: 1,
      scopeSignal: 'unknown',
      occupancy: 'unknown',
    });
  };

  /** A generator stub returning a fixed outcome per call, recording who it saw. */
  function fakeGenerator(outcomeFor: (callId: string) => NoteGenerationResult): {
    generate: TechnicianNoteGenerator;
    seen: string[];
  } {
    const seen: string[] = [];
    return {
      seen,
      generate: (callId) => {
        seen.push(callId);
        return Promise.resolve(outcomeFor(callId));
      },
    };
  }

  const run = async (
    overrides: Partial<Parameters<typeof runTechnicianNotes>[0]> = {},
    config: Record<string, unknown> = {},
  ): ReturnType<typeof runTechnicianNotes> =>
    runTechnicianNotes({
      pool: app,
      config: makeTestConfig({ TECHNICIAN_NOTES_ENABLED: true, ...config }),
      logger,
      generate: () => Promise.resolve({ outcome: 'generated' }),
      emitDegradedAlert: () => Promise.resolve(),
      ...overrides,
    });

  beforeAll(async () => {
    owner = makePool();
    await migrate('up');
    app = makeAppPool();
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  afterEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });

  describe('the kill switch', () => {
    it('refuses to run, before any lock or ping, when disabled', async () => {
      const { monitor, events } = fakeMonitor();
      await expect(run({ monitor }, { TECHNICIAN_NOTES_ENABLED: false })).rejects.toBeInstanceOf(
        TechnicianNoteError,
      );
      expect(events).toEqual([]);
    });

    it('names `disabled` as the refusal reason', async () => {
      await run({}, { TECHNICIAN_NOTES_ENABLED: false }).then(
        () => expect.unreachable('expected a refusal'),
        (err: unknown) => {
          expect((err as TechnicianNoteError).reason).toBe('disabled');
        },
      );
    });
  });

  describe('eligibility', () => {
    it('picks up calls with a knowledge row and skips those without one', async () => {
      await seed('test-noterun-a');
      await upsertCallState(app, {
        callId: 'test-noterun-no-knowledge',
        source: 'test',
        currentStage: 'mark-retention-eligible',
        status: 'completed',
      });
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      const summary = await run({ generate });

      expect(seen).toEqual(['test-noterun-a']);
      expect(summary.eligible).toBe(1);
    });

    it('skips a call that already has a note at the current prompt version', async () => {
      await seed('test-noterun-done');
      await seedNote('test-noterun-done', TECHNICIAN_NOTE_PROMPT_VERSION);
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      const summary = await run({ generate });

      expect(seen).toEqual([]);
      expect(summary.eligible).toBe(0);
    });

    it('picks up a call whose note is at an OLDER prompt version', async () => {
      await seed('test-noterun-stale');
      await seedNote('test-noterun-stale', 'tech-note-v0');
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      await run({ generate });

      expect(seen).toEqual(['test-noterun-stale']);
    });

    it('--regenerate rewrites a note that is already at the current version', async () => {
      await seed('test-noterun-regen');
      await seedNote('test-noterun-regen', TECHNICIAN_NOTE_PROMPT_VERSION);
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      await run({ generate, regenerate: true });

      expect(seen).toEqual(['test-noterun-regen']);
    });

    it('excludes a superseded duplicate call leg', async () => {
      await seed('test-noterun-canonical');
      await seed('test-noterun-dupe');
      await setStructuredKnowledgeSuperseded(app, {
        callId: 'test-noterun-dupe',
        canonicalCallId: 'test-noterun-canonical',
      });
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      await run({ generate });

      expect(seen).toEqual(['test-noterun-canonical']);
    });

    it('does NOT filter out calls with an unreadable transcript — they must be counted', async () => {
      await seed('test-noterun-notx');
      await softDeleteCleanTranscript(app, 'test-noterun-notx');

      const candidates = await listNoteCandidateCallIds(app, {
        promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
        regenerate: false,
        limit: 50,
      });
      expect(candidates).toContain('test-noterun-notx');
    });

    /**
     * A category-scoped run: the way to note ONE part of the corpus (a new prompt tried on grinder
     * pumps and water heaters first) without spending a model call on the rest of it. The scope is
     * a filter on the candidate query, so every other rule — prompt-version skip, superseded legs,
     * the non-dispatchable exclusion — still applies inside it.
     */
    describe('the --categories scope', () => {
      it('generates only for calls in the named categories', async () => {
        await seed('test-noterun-cat-gp', { serviceCategory: 'grinder_pump' });
        await seed('test-noterun-cat-wh', { serviceCategory: 'water_heater' });
        await seed('test-noterun-cat-toilet', { serviceCategory: 'toilet' });
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        const summary = await run({ generate, categories: ['grinder_pump', 'water_heater'] });

        expect(seen.sort()).toEqual(['test-noterun-cat-gp', 'test-noterun-cat-wh']);
        expect(summary.eligible).toBe(2);
      });

      it('still skips a scoped call that already has a note at the current version', async () => {
        await seed('test-noterun-cat-done', { serviceCategory: 'grinder_pump' });
        await seedNote('test-noterun-cat-done', TECHNICIAN_NOTE_PROMPT_VERSION);
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        await run({ generate, categories: ['grinder_pump'] });

        expect(seen).toEqual([]);
      });

      it('filters the candidate query itself, so no model call is ever reserved', async () => {
        await seed('test-noterun-cat-q1', { serviceCategory: 'grinder_pump' });
        await seed('test-noterun-cat-q2', { serviceCategory: 'drain_blockage' });

        const candidates = await listNoteCandidateCallIds(app, {
          promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
          regenerate: false,
          limit: 50,
          categories: ['grinder_pump'],
        });

        expect(candidates).toContain('test-noterun-cat-q1');
        expect(candidates).not.toContain('test-noterun-cat-q2');
      });

      it('counts the non-dispatchable exclusion inside the scope, not across the corpus', async () => {
        await seed('test-noterun-cat-gen', { callIntent: 'general', serviceCategory: 'other' });
        await seed('test-noterun-cat-keep', { serviceCategory: 'grinder_pump' });
        const { generate } = fakeGenerator(() => ({ outcome: 'generated' }));

        const summary = await run({ generate, categories: ['grinder_pump'] });

        // The excluded call is out of scope, so it is not this run's business to report it.
        expect(summary.nonDispatchableExcluded).toBe(0);
        expect(
          await countNonDispatchableCandidates(app, {
            promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
            regenerate: false,
            categories: ['grinder_pump'],
          }),
        ).toBe(0);
      });
    });

    /**
     * A technician is never sent to a general enquiry or a billing question, so a note for one is
     * a model call spent to produce an empty gap list that then sits on the review surface looking
     * like a failure. The rule is deliberately a CONJUNCTION — intent AND no plumbing topic — so
     * a real job filed under the wrong intent keeps its note. These four cases pin both halves.
     */
    describe('non-dispatchable exclusion', () => {
      it('excludes a general or billing call with no plumbing topic', async () => {
        await seed('test-noterun-general', { callIntent: 'general', serviceCategory: 'other' });
        await seed('test-noterun-billing', { callIntent: 'billing', serviceCategory: 'other' });
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        await run({ generate });

        expect(seen).not.toContain('test-noterun-general');
        expect(seen).not.toContain('test-noterun-billing');
      });

      it('KEEPS a general or billing call that named a real plumbing topic', async () => {
        await seed('test-noterun-genwh', {
          callIntent: 'general',
          serviceCategory: 'water_heater',
        });
        await seed('test-noterun-billwh', { callIntent: 'billing', serviceCategory: 'toilet' });
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        await run({ generate });

        expect(seen).toContain('test-noterun-genwh');
        expect(seen).toContain('test-noterun-billwh');
      });

      it('KEEPS a real job whose topic could not be categorised', async () => {
        await seed('test-noterun-jobother', {
          callIntent: 'existing_job',
          serviceCategory: 'other',
        });
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        await run({ generate });

        expect(seen).toContain('test-noterun-jobother');
      });

      it('reports the excluded count on the summary without spending a model call', async () => {
        await seed('test-noterun-x1', { callIntent: 'general', serviceCategory: 'other' });
        await seed('test-noterun-x2', { callIntent: 'billing', serviceCategory: 'other' });
        await seed('test-noterun-keep');
        const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

        const summary = await run({ generate });

        expect(summary.nonDispatchableExcluded).toBe(2);
        expect(summary.eligible).toBe(1);
        expect(seen).toEqual(['test-noterun-keep']);

        expect(
          await countNonDispatchableCandidates(app, {
            promptVersion: TECHNICIAN_NOTE_PROMPT_VERSION,
            regenerate: false,
          }),
        ).toBe(2);
      });
    });
  });

  describe('counting', () => {
    it('tallies every outcome into the summary', async () => {
      const outcomes: Record<string, NoteGenerationResult['outcome']> = {
        'test-noterun-c1': 'generated',
        'test-noterun-c2': 'skipped_no_transcript',
        'test-noterun-c3': 'failed_schema',
        'test-noterun-c4': 'failed_model',
      };
      for (const id of Object.keys(outcomes)) await seed(id);
      const { generate } = fakeGenerator((id) => ({
        outcome: outcomes[id] as NoteGenerationResult['outcome'],
      }));

      const summary = await run({ generate });

      expect(summary).toMatchObject({
        eligible: 4,
        attempted: 3,
        generated: 1,
        skippedNoTranscript: 1,
        failedSchema: 1,
        failedModel: 1,
        pausedOnCostCap: false,
        dryRun: false,
      });
    });

    it('counts a residual nulling', async () => {
      await seed('test-noterun-res');
      const { generate } = fakeGenerator(() => ({
        outcome: 'generated',
        residualCounts: { digit_run: 1 },
      }));

      expect((await run({ generate })).residualNullings).toBe(1);
    });

    it('does not count a skipped call as attempted', async () => {
      await seed('test-noterun-skip');
      const { generate } = fakeGenerator(() => ({ outcome: 'skipped_no_transcript' }));
      const summary = await run({ generate });
      expect(summary.attempted).toBe(0);
      expect(summary.skippedNoTranscript).toBe(1);
    });
  });

  describe('paging and --limit', () => {
    it('pages through more calls than one batch holds', async () => {
      for (let i = 0; i < 5; i += 1) await seed(`test-noterun-p${String(i)}`);
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      const summary = await run({ generate }, { TECHNICIAN_NOTES_BATCH_SIZE: 2 });

      expect(summary.eligible).toBe(5);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('stops after --limit eligible calls', async () => {
      for (let i = 0; i < 5; i += 1) await seed(`test-noterun-l${String(i)}`);
      const { generate, seen } = fakeGenerator(() => ({ outcome: 'generated' }));

      const summary = await run({ generate, limit: 3 }, { TECHNICIAN_NOTES_BATCH_SIZE: 2 });

      expect(summary.eligible).toBe(3);
      expect(seen).toHaveLength(3);
    });
  });

  describe('dry run', () => {
    it('counts eligible, skipped-no-transcript and would-generate with zero model calls', async () => {
      await seed('test-noterun-d1');
      await seed('test-noterun-d2');
      await softDeleteCleanTranscript(app, 'test-noterun-d2');
      const generate = vi.fn<TechnicianNoteGenerator>();

      const summary = await run({ generate, dryRun: true });

      expect(generate).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        dryRun: true,
        eligible: 2,
        skippedNoTranscript: 1,
        generated: 0,
        attempted: 0,
      });
      // would-generate = eligible - skippedNoTranscript
      expect(summary.eligible - summary.skippedNoTranscript).toBe(1);
    });

    it('writes nothing at all', async () => {
      await seed('test-noterun-dwrite');
      const generate = vi.fn<TechnicianNoteGenerator>();

      await run({ generate, dryRun: true });

      for (const table of ['technician_notes', 'model_invocations', 'processing_log']) {
        const r = await owner.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE call_id = $1`,
          ['test-noterun-dwrite'],
        );
        expect(Number(r.rows[0]?.n), table).toBe(0);
      }
    });

    it('sends no pings EVEN when handed a monitor — a preview is not a run', async () => {
      await seed('test-noterun-dping');
      const { monitor, events } = fakeMonitor();

      // The monitor is deliberately supplied: the runner itself must refuse to ping on a dry
      // run, so a previewing schedule can never keep the external check green.
      await run({ generate: vi.fn<TechnicianNoteGenerator>(), dryRun: true, monitor });

      expect(events).toEqual([]);
    });
  });

  describe('the monitor contract', () => {
    it('pings start, then progress per page, then exactly one success', async () => {
      for (let i = 0; i < 3; i += 1) await seed(`test-noterun-m${String(i)}`);
      const { monitor, events } = fakeMonitor();
      const { generate } = fakeGenerator(() => ({ outcome: 'generated' }));

      await run({ generate, monitor }, { TECHNICIAN_NOTES_BATCH_SIZE: 2 });

      expect(events[0]).toBe('start');
      expect(events.filter((e) => e.startsWith('progress:'))).toHaveLength(2);
      expect(events.filter((e) => e === 'success')).toHaveLength(1);
      expect(events).not.toContain('fail');
      expect(events[events.length - 1]).toBe('success');
    });

    it('fails the monitor and rethrows when the run throws', async () => {
      await seed('test-noterun-boom');
      const { monitor, events } = fakeMonitor();
      const generate = (): Promise<NoteGenerationResult> =>
        Promise.reject(new Error('generator exploded'));

      await expect(run({ generate, monitor })).rejects.toThrow('generator exploded');
      expect(events).toContain('fail');
      expect(events).not.toContain('success');
    });
  });

  describe('the cost cap PAUSES rather than fails', () => {
    it('stops the loop, marks the run paused, and still takes the success ping', async () => {
      for (let i = 0; i < 4; i += 1) await seed(`test-noterun-cc${String(i)}`);
      const { monitor, events } = fakeMonitor();
      const seen: string[] = [];
      const generate: TechnicianNoteGenerator = (callId) => {
        seen.push(callId);
        return Promise.resolve(
          seen.length >= 2 ? { outcome: 'cost_cap' } : { outcome: 'generated' },
        );
      };

      const summary = await run({ generate, monitor });

      expect(summary.pausedOnCostCap).toBe(true);
      expect(summary.generated).toBe(1);
      // Stopped immediately — the remaining calls were never attempted.
      expect(seen).toHaveLength(2);
      // A paused run is a CLEAN end: the deduped MODEL_COST_CAP_EXCEEDED alert is the operator
      // signal, so the monitor must stay green rather than paging someone over a budget cap.
      expect(events).toContain('success');
      expect(events).not.toContain('fail');
    });

    it('does not count the cost-capped call as attempted or failed', async () => {
      await seed('test-noterun-cc-only');
      const { generate } = fakeGenerator(() => ({ outcome: 'cost_cap' }));

      const summary = await run({ generate });

      expect(summary.attempted).toBe(0);
      expect(summary.failedSchema).toBe(0);
      expect(summary.failedModel).toBe(0);
      expect(summary.pausedOnCostCap).toBe(true);
    });
  });

  describe('the failure-rate alert', () => {
    const seedMany = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) await seed(`test-noterun-f${String(i).padStart(2, '0')}`);
    };

    it('fires when the failure rate crosses the threshold over enough attempts', async () => {
      await seedMany(10);
      const emitDegradedAlert = vi.fn(() => Promise.resolve());
      let n = 0;
      const generate: TechnicianNoteGenerator = () => {
        n += 1;
        return Promise.resolve({ outcome: n <= 5 ? 'failed_schema' : 'generated' });
      };

      await run(
        { generate, emitDegradedAlert },
        {
          TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS: 10,
          TECHNICIAN_NOTES_FAILURE_RATE_ALERT_THRESHOLD: 0.2,
        },
      );

      expect(emitDegradedAlert).toHaveBeenCalledTimes(1);
      expect(emitDegradedAlert).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'technician-notes' }),
      );
    });

    it('stays quiet below the threshold', async () => {
      await seedMany(10);
      const emitDegradedAlert = vi.fn(() => Promise.resolve());
      let n = 0;
      const generate: TechnicianNoteGenerator = () => {
        n += 1;
        return Promise.resolve({ outcome: n === 1 ? 'failed_schema' : 'generated' });
      };

      await run(
        { generate, emitDegradedAlert },
        {
          TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS: 10,
          TECHNICIAN_NOTES_FAILURE_RATE_ALERT_THRESHOLD: 0.2,
        },
      );

      expect(emitDegradedAlert).not.toHaveBeenCalled();
    });

    it('stays quiet below the minimum attempt count, even at a 100% failure rate', async () => {
      await seed('test-noterun-solo');
      const emitDegradedAlert = vi.fn(() => Promise.resolve());
      const { generate } = fakeGenerator(() => ({ outcome: 'failed_schema' }));

      await run(
        { generate, emitDegradedAlert },
        { TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS: 20 },
      );

      expect(emitDegradedAlert).not.toHaveBeenCalled();
    });

    it('fires at most once per run', async () => {
      await seedMany(10);
      const emitDegradedAlert = vi.fn(() => Promise.resolve());
      const { generate } = fakeGenerator(() => ({ outcome: 'failed_model' }));

      await run(
        { generate, emitDegradedAlert },
        { TECHNICIAN_NOTES_FAILURE_ALERT_MIN_ATTEMPTS: 5 },
      );

      expect(emitDegradedAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('the advisory lock', () => {
    it('refuses a second concurrent run', async () => {
      await seed('test-noterun-lock');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = run({
        generate: async () => {
          await held;
          return { outcome: 'generated' };
        },
      });
      // Give the first run time to take the lock before the second tries.
      await new Promise((r) => setTimeout(r, 50));

      const second = run({ generate: () => Promise.resolve({ outcome: 'generated' }) });
      await expect(second).rejects.toMatchObject({ reason: 'already_running' });

      release();
      await first;
    });

    it('releases the lock so a later run can proceed', async () => {
      await seed('test-noterun-lock2');
      await run({ generate: () => Promise.resolve({ outcome: 'generated' }) });
      await expect(
        run({ generate: () => Promise.resolve({ outcome: 'generated' }) }),
      ).resolves.toBeDefined();
    });
  });
});
