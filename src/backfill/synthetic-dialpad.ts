import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
  DialpadClient,
  RecentCall,
  RecentCallsPage,
  TranscriptResult,
} from '../dialpad/client/index.js';
import { BackfillError } from './errors.js';

/**
 * A fixture-backed {@link DialpadClient} for the STAGING SYNTHETIC backfill mode (Task 11.2, §7).
 * Loads a synthetic fixture from disk and serves list + transcript from it — NO network, so it is
 * the only Dialpad client ever built when `NODE_ENV=staging`. The real `createDialpadClient` is
 * never constructed on the staging path.
 *
 * Delayed-transcript rule (R5 #2): synthetic fixtures must supply READY transcripts only. A fixture
 * with any listed call lacking a non-empty transcript (i.e. `fetchTranscript` would return
 * `not_ready`) is REJECTED at load with `invalid_synthetic_fixture`, BEFORE the run starts — so the
 * inline path never defers/stalls and the smoke path stays free of retry-queue machinery.
 */

const fixtureCallSchema = z.object({
  callId: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  state: z.string().optional(),
  direction: z.string().optional(),
  duration: z.number().optional(),
});

const fixtureSchema = z.object({
  calls: z.array(fixtureCallSchema),
  /** callId → ready raw transcript body (non-empty). A missing/empty entry = would-be not_ready. */
  transcripts: z.record(z.string(), z.string()),
});

export type SyntheticDialpadFixture = z.infer<typeof fixtureSchema>;

function toRecentCall(c: z.infer<typeof fixtureCallSchema>): RecentCall {
  return {
    callId: c.callId,
    startedAt: c.startedAt,
    ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
    ...(c.state !== undefined ? { state: c.state } : {}),
    ...(c.direction !== undefined ? { direction: c.direction } : {}),
    ...(c.duration !== undefined ? { duration: c.duration } : {}),
  };
}

/** Build a fixture-backed DialpadClient from an already-parsed, already-validated fixture. */
export function createSyntheticDialpadClient(fixture: SyntheticDialpadFixture): DialpadClient {
  const calls = fixture.calls.map(toRecentCall);
  const transcripts = fixture.transcripts;
  return {
    fetchTranscript(callId: string): Promise<TranscriptResult> {
      const body = transcripts[callId];
      // Load validation guarantees a ready transcript for every listed call, so this is always
      // `ready` for an in-fixture call; an unknown id is defensively `not_ready`.
      if (body === undefined || body.length === 0) {
        return Promise.resolve({ kind: 'not_ready' });
      }
      return Promise.resolve({ kind: 'ready', transcript: body });
    },
    listRecentlyConcludedCalls(opts: { since: Date | number }): Promise<RecentCallsPage> {
      const sinceMs = typeof opts.since === 'number' ? opts.since : opts.since.getTime();
      // Single page (no cursor); filter by started_after like the real list endpoint.
      const page = calls.filter((c) => c.startedAt !== undefined && c.startedAt >= sinceMs);
      return Promise.resolve({ calls: page });
    },
  };
}

/**
 * Load + validate a synthetic fixture from `path`, then return a fixture-backed client. Fails closed
 * with `BackfillError('invalid_synthetic_fixture')` on a read/parse/shape error, a listed call with
 * no `startedAt`, or any listed call whose transcript would be not-ready (missing/empty) — all
 * BEFORE the run starts.
 */
export async function loadSyntheticDialpadFixture(path: string): Promise<DialpadClient> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new BackfillError(
      'invalid_synthetic_fixture',
      'cannot read the synthetic Dialpad fixture',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BackfillError(
      'invalid_synthetic_fixture',
      'synthetic Dialpad fixture is not valid JSON',
    );
  }
  const parsed = fixtureSchema.safeParse(json);
  if (!parsed.success) {
    throw new BackfillError(
      'invalid_synthetic_fixture',
      'synthetic Dialpad fixture has an unrecognised shape (needs calls[] with startedAt + transcripts map)',
    );
  }
  // Ready-transcript-only invariant: every listed call must have a non-empty transcript.
  for (const call of parsed.data.calls) {
    const body = parsed.data.transcripts[call.callId];
    if (body === undefined || body.length === 0) {
      throw new BackfillError(
        'invalid_synthetic_fixture',
        'synthetic fixtures must supply ready transcripts only — a listed call has no non-empty transcript',
        { call_id: call.callId },
      );
    }
  }
  return createSyntheticDialpadClient(parsed.data);
}
