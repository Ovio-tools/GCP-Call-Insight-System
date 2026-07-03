import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DialpadClient, RecentCall, RecentCallsPage } from '../../src/dialpad/client/index.js';
import { DialpadError } from '../../src/dialpad/client/index.js';
import {
  requireReconciliationCheckUrl,
  runReconciliation,
  type ReconciliationDeps,
} from '../../src/reconciliation/run.js';
import { ConfigError } from '../../src/config/index.js';
import { createRootLogger } from '../../src/logging/logger.js';
import { makeTestConfig } from '../_config.js';

const CHECK_URL = 'https://checks.example.com/ping/reconciliation';

function collectingLogger(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
}

/** A Dialpad client whose listing is scripted page-by-page and whose transcript fetch must
 * never fire — the reconciliation sweep is metadata-only. */
function fakeClient(pages: RecentCallsPage[] | Error): {
  client: DialpadClient;
  listSpy: ReturnType<typeof vi.fn>;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const listSpy = vi.fn((): Promise<RecentCallsPage> => {
    if (pages instanceof Error) return Promise.reject(pages);
    const page = pages[i] ?? { calls: [] };
    i += 1;
    return Promise.resolve(page);
  });
  const fetchSpy = vi.fn(() => Promise.reject(new Error('transcript fetch must never run')));
  return {
    client: { listRecentlyConcludedCalls: listSpy, fetchTranscript: fetchSpy },
    listSpy,
    fetchSpy,
  };
}

interface HarnessOptions {
  pages?: RecentCallsPage[] | Error;
  existing?: string[];
  checkUrl?: string | undefined;
  ingestGap?: ReconciliationDeps['ingestGap'];
  heartbeat?: ReconciliationDeps['heartbeat'];
  windowMinutes?: number;
  maxCallMinutes?: number;
}

const NOW = 1_750_000_000_000;

function makeHarness(opts: HarnessOptions = {}) {
  const { lines, logger } = collectingLogger();
  const { client, listSpy, fetchSpy } = fakeClient(opts.pages ?? [{ calls: [] }]);
  const existing = new Set(opts.existing ?? []);
  const alreadyInPipeline = vi.fn((callId: string) => Promise.resolve(existing.has(callId)));
  const ingestGap = vi.fn(opts.ingestGap ?? ((_call: RecentCall) => Promise.resolve()));
  const config = makeTestConfig({
    RECONCILIATION_CHECK_URL: 'checkUrl' in opts ? opts.checkUrl : CHECK_URL,
    ...(opts.windowMinutes !== undefined
      ? { RECONCILIATION_WINDOW_MINUTES: opts.windowMinutes }
      : {}),
    ...(opts.maxCallMinutes !== undefined
      ? { RECONCILIATION_MAX_CALL_MINUTES: opts.maxCallMinutes }
      : {}),
  });
  const heartbeat = opts.heartbeat ? vi.fn(opts.heartbeat) : undefined;
  const deps: ReconciliationDeps = {
    config,
    logger,
    client,
    alreadyInPipeline,
    ingestGap,
    ...(heartbeat ? { heartbeat } : {}),
    clock: { now: () => NOW },
  };
  return {
    deps,
    lines,
    listSpy,
    fetchSpy,
    alreadyInPipeline,
    ingestGap,
    heartbeat,
    config,
  };
}

describe('runReconciliation', () => {
  it('enqueues a missed call (no call_state row) exactly once', async () => {
    const h = makeHarness({ pages: [{ calls: [{ callId: 'rc-missed-1' }] }] });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.ingestGap).toHaveBeenCalledWith({ callId: 'rc-missed-1' });
    expect(summary).toEqual({ callsChecked: 1, gapsEnqueued: 1 });
  });

  it('writes the in-DB heartbeat mirror on a successful sweep, with the run summary', async () => {
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-hb-1' }] }],
      heartbeat: () => Promise.resolve(),
    });

    await runReconciliation(h.deps);

    expect(h.heartbeat).toHaveBeenCalledTimes(1);
    expect(h.heartbeat).toHaveBeenCalledWith({ callsChecked: 1, gapsEnqueued: 1 });
  });

  it('a failing heartbeat mirror is sanitized-logged and never fails the run', async () => {
    const h = makeHarness({
      pages: [{ calls: [] }],
      heartbeat: () => Promise.reject(new Error('db write failed')),
    });

    await expect(runReconciliation(h.deps)).resolves.toEqual({ callsChecked: 0, gapsEnqueued: 0 });
    expect(h.lines.some((l) => l.includes('heartbeat DB mirror failed'))).toBe(true);
  });

  it('skips a call that already has a call_state row (any status)', async () => {
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-done-1' }, { callId: 'rc-missed-2' }] }],
      existing: ['rc-done-1'],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.ingestGap).toHaveBeenCalledWith({ callId: 'rc-missed-2' });
    expect(summary).toEqual({ callsChecked: 2, gapsEnqueued: 1 });
  });

  it('walks pagination cursors and dedupes a call repeated across pages', async () => {
    const h = makeHarness({
      pages: [
        { calls: [{ callId: 'rc-a' }], cursor: 'page-2' },
        { calls: [{ callId: 'rc-a' }, { callId: 'rc-b' }] },
      ],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.listSpy).toHaveBeenCalledTimes(2);
    expect(h.listSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2' }));
    expect(h.ingestGap).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ callsChecked: 2, gapsEnqueued: 2 });
  });

  it('widens started_after by the max-call-duration margin so long calls that ENDED in-window are listed', async () => {
    // Dialpad's list API filters by START time only (no ended_after exists). A call that
    // started 2h ago but concluded 5 minutes ago must still be swept, so the query reaches
    // back window + max-call-duration.
    const h = makeHarness({ windowMinutes: 45, maxCallMinutes: 180 });

    await runReconciliation(h.deps);

    expect(h.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ since: NOW - (45 + 180) * 60_000 }),
    );
  });

  it('enqueues a call that started before the window but CONCLUDED inside it', async () => {
    const h = makeHarness({
      windowMinutes: 45,
      maxCallMinutes: 180,
      // Started 2h ago (outside the 45-min window), ended 5 min ago (inside it).
      pages: [{ calls: [{ callId: 'rc-long', endedAt: NOW - 5 * 60_000 }] }],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ callsChecked: 1, gapsEnqueued: 1 });
  });

  it('skips a call the widened lookback listed but which concluded BEFORE the window', async () => {
    const h = makeHarness({
      windowMinutes: 45,
      pages: [
        {
          calls: [
            { callId: 'rc-old', endedAt: NOW - 46 * 60_000 },
            { callId: 'rc-fresh', endedAt: NOW - 44 * 60_000 },
          ],
        },
      ],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.ingestGap).toHaveBeenCalledWith(expect.objectContaining({ callId: 'rc-fresh' }));
    expect(summary).toEqual({ callsChecked: 2, gapsEnqueued: 1 });
  });

  it('a call with NO end timestamp and no recognisable state is still swept — fail open', async () => {
    // date_ended and state are provisional fields (docs are login-gated). Excluding on their
    // ABSENCE could silently blind the whole sweep; inclusion is idempotent-safe and the
    // transcript-wait machinery absorbs a not-yet-ended call.
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-no-end' }, { callId: 'rc-odd-state', state: 'wibble' }] }],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ callsChecked: 2, gapsEnqueued: 2 });
  });

  it('a call with no end timestamp but a POSITIVELY in-progress state is not swept yet', async () => {
    // An active call has not "concluded in a recent window"; enqueueing it now could burn the
    // bounded transcript wait and hold it missing_transcript before it even ends. It is only
    // skipped on affirmative evidence — a recognised non-terminal state — never on absence.
    const h = makeHarness({
      pages: [
        {
          calls: [
            { callId: 'rc-active', state: 'active' },
            { callId: 'rc-mid', state: 'In_Progress' },
            { callId: 'rc-ring', state: 'ringing' },
            { callId: 'rc-queued', state: 'queued' },
            { callId: 'rc-done', state: 'hangup' },
          ],
        },
      ],
    });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.ingestGap).toHaveBeenCalledWith(expect.objectContaining({ callId: 'rc-done' }));
    expect(summary).toEqual({ callsChecked: 5, gapsEnqueued: 1 });
  });

  it('a terminal-state call with no end timestamp is swept', async () => {
    const h = makeHarness({ pages: [{ calls: [{ callId: 'rc-hangup', state: 'hangup' }] }] });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ callsChecked: 1, gapsEnqueued: 1 });
  });

  it('exits cleanly on an empty window and logs checked=0 enqueued=0', async () => {
    const h = makeHarness({ pages: [{ calls: [] }] });

    const summary = await runReconciliation(h.deps);

    expect(summary).toEqual({ callsChecked: 0, gapsEnqueued: 0 });
    expect(h.ingestGap).not.toHaveBeenCalled();
    const summaryLines = h.lines.filter((l) => l.includes('reconciliation sweep complete'));
    expect(summaryLines).toHaveLength(1);
    const parsed = JSON.parse(summaryLines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ calls_checked: 0, gaps_enqueued: 0 });
  });

  it('a Dialpad listing failure rejects and enqueues nothing (the entrypoint withholds the ping)', async () => {
    const err = new DialpadError('rate_limited', { endpoint: 'calls', status: 429, attempts: 5 });
    const h = makeHarness({ pages: err });

    await expect(runReconciliation(h.deps)).rejects.toBe(err);

    expect(h.ingestGap).not.toHaveBeenCalled();
  });

  it('an enqueue failure rejects (the entrypoint withholds the ping)', async () => {
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-boom' }] }],
      ingestGap: () => Promise.reject(new Error('redis down')),
    });

    await expect(runReconciliation(h.deps)).rejects.toThrow('redis down');
  });

  it('a mid-pagination failure after some enqueues still rejects', async () => {
    const err = new DialpadError('unavailable', { endpoint: 'calls', attempts: 5 });
    const h = makeHarness();
    h.listSpy
      .mockResolvedValueOnce({ calls: [{ callId: 'rc-early' }], cursor: 'page-2' })
      .mockRejectedValueOnce(err);

    await expect(runReconciliation(h.deps)).rejects.toBe(err);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
  });

  it('a cursor that does not advance is surfaced as an api_changed contract failure', async () => {
    const h = makeHarness({
      pages: [
        { calls: [{ callId: 'rc-loop' }], cursor: 'stuck' },
        { calls: [], cursor: 'stuck' },
      ],
    });

    await expect(runReconciliation(h.deps)).rejects.toMatchObject({ kind: 'api_changed' });
  });

  it('never calls the transcript-fetch method', async () => {
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-meta-only', state: 'hangup', duration: 42 }] }],
    });

    await runReconciliation(h.deps);

    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('a successful sweep logs EXACTLY one line — the counts-only summary, no per-call logs', async () => {
    const h = makeHarness({
      pages: [
        {
          calls: [
            { callId: 'rc-log-1', state: 'hangup', direction: 'inbound', duration: 63 },
            { callId: 'rc-log-2', state: 'hangup', direction: 'outbound', duration: 9 },
          ],
        },
      ],
      existing: ['rc-log-2'],
    });

    await runReconciliation(h.deps);

    expect(h.lines).toHaveLength(1);
    const parsed = JSON.parse(h.lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      calls_checked: 2,
      gaps_enqueued: 1,
      msg: 'reconciliation sweep complete',
    });
    const allowedKeys = new Set([
      // pino built-ins
      'level',
      'time',
      'pid',
      'hostname',
      'name',
      'service',
      'msg',
      // ours: counts only — never a call_id, metadata value, or content
      'calls_checked',
      'gaps_enqueued',
      'window_minutes',
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowedKeys, `unexpected log field "${key}"`).toContain(key);
    }
    expect(h.lines[0]).not.toMatch(/rc-log-1|inbound|outbound|hangup/);
  });
});

describe('requireReconciliationCheckUrl', () => {
  it('in production, a missing RECONCILIATION_CHECK_URL fails loudly, NAMING the variable', () => {
    const config = makeTestConfig({ NODE_ENV: 'production', RECONCILIATION_CHECK_URL: undefined });

    expect(() => requireReconciliationCheckUrl(config)).toThrowError(ConfigError);
    expect(() => requireReconciliationCheckUrl(config)).toThrowError(
      /CONFIG_MISSING_OR_INVALID.*RECONCILIATION_CHECK_URL/,
    );
  });

  it('in production, a configured URL passes', () => {
    const config = makeTestConfig({ NODE_ENV: 'production', RECONCILIATION_CHECK_URL: CHECK_URL });

    expect(() => requireReconciliationCheckUrl(config)).not.toThrow();
  });

  it('outside production, omission is allowed (local dev / tests skip the ping)', () => {
    const config = makeTestConfig({ RECONCILIATION_CHECK_URL: undefined });

    expect(() => requireReconciliationCheckUrl(config)).not.toThrow();
  });
});
