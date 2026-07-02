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
  pingCheck?: ReconciliationDeps['pingCheck'];
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
  const pingCheck = vi.fn(opts.pingCheck ?? ((_url: string) => Promise.resolve()));
  const config = makeTestConfig({
    RECONCILIATION_CHECK_URL: 'checkUrl' in opts ? opts.checkUrl : CHECK_URL,
    ...(opts.windowMinutes !== undefined
      ? { RECONCILIATION_WINDOW_MINUTES: opts.windowMinutes }
      : {}),
    ...(opts.maxCallMinutes !== undefined
      ? { RECONCILIATION_MAX_CALL_MINUTES: opts.maxCallMinutes }
      : {}),
  });
  const deps: ReconciliationDeps = {
    config,
    logger,
    client,
    alreadyInPipeline,
    ingestGap,
    pingCheck,
    clock: { now: () => NOW },
  };
  return { deps, lines, listSpy, fetchSpy, alreadyInPipeline, ingestGap, pingCheck, config };
}

describe('runReconciliation', () => {
  it('enqueues a missed call (no call_state row) exactly once', async () => {
    const h = makeHarness({ pages: [{ calls: [{ callId: 'rc-missed-1' }] }] });

    const summary = await runReconciliation(h.deps);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.ingestGap).toHaveBeenCalledWith({ callId: 'rc-missed-1' });
    expect(summary).toEqual({ callsChecked: 1, gapsEnqueued: 1 });
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

  it('pings its own external check exactly once, only after full success', async () => {
    const h = makeHarness({ pages: [{ calls: [{ callId: 'rc-ping-1' }] }] });

    await runReconciliation(h.deps);

    expect(h.pingCheck).toHaveBeenCalledTimes(1);
    expect(h.pingCheck).toHaveBeenCalledWith(CHECK_URL);
    // Ordering: the ping is the LAST thing that happens, after every gap is enqueued.
    expect(h.pingCheck.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.ingestGap.mock.invocationCallOrder[0]!,
    );
  });

  it('does not ping when no check URL is configured', async () => {
    const h = makeHarness({ checkUrl: undefined });

    await runReconciliation(h.deps);

    expect(h.pingCheck).not.toHaveBeenCalled();
  });

  it('a ping failure is logged but does not fail the run — the monitor itself is the alarm', async () => {
    const h = makeHarness({
      pingCheck: () => Promise.reject(new Error('monitor unreachable')),
    });

    const summary = await runReconciliation(h.deps);

    expect(summary).toEqual({ callsChecked: 0, gapsEnqueued: 0 });
    expect(h.lines.some((l) => l.includes('external check ping failed'))).toBe(true);
  });

  it('a Dialpad listing failure rejects, enqueues nothing, and never pings', async () => {
    const err = new DialpadError('rate_limited', { endpoint: 'calls', status: 429, attempts: 5 });
    const h = makeHarness({ pages: err });

    await expect(runReconciliation(h.deps)).rejects.toBe(err);

    expect(h.ingestGap).not.toHaveBeenCalled();
    expect(h.pingCheck).not.toHaveBeenCalled();
  });

  it('an enqueue failure rejects and never pings', async () => {
    const h = makeHarness({
      pages: [{ calls: [{ callId: 'rc-boom' }] }],
      ingestGap: () => Promise.reject(new Error('redis down')),
    });

    await expect(runReconciliation(h.deps)).rejects.toThrow('redis down');

    expect(h.pingCheck).not.toHaveBeenCalled();
  });

  it('a mid-pagination failure after some enqueues still rejects without pinging', async () => {
    const err = new DialpadError('unavailable', { endpoint: 'calls', attempts: 5 });
    const h = makeHarness();
    h.listSpy
      .mockResolvedValueOnce({ calls: [{ callId: 'rc-early' }], cursor: 'page-2' })
      .mockRejectedValueOnce(err);

    await expect(runReconciliation(h.deps)).rejects.toBe(err);

    expect(h.ingestGap).toHaveBeenCalledTimes(1);
    expect(h.pingCheck).not.toHaveBeenCalled();
  });

  it('a cursor that does not advance is surfaced as an api_changed contract failure', async () => {
    const h = makeHarness({
      pages: [
        { calls: [{ callId: 'rc-loop' }], cursor: 'stuck' },
        { calls: [], cursor: 'stuck' },
      ],
    });

    await expect(runReconciliation(h.deps)).rejects.toMatchObject({ kind: 'api_changed' });
    expect(h.pingCheck).not.toHaveBeenCalled();
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
