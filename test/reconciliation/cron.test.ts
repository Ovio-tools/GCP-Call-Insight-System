import { describe, expect, it, vi } from 'vitest';
import { runReconciliationCron } from '../../src/reconciliation/run.js';
import type { ScanResult } from '../../src/review-queue/scan.js';
import { makeTestConfig } from '../_config.js';
import { makeCapturingLogger } from '../http/_helpers.js';

const CHECK_URL = 'https://checks.example.com/ping/reconciliation';

const scanResult = (over: Partial<ScanResult> = {}): ScanResult => ({
  escalated: 0,
  failed: 0,
  lockedSkipped: 0,
  ...over,
});

function makeDeps(
  opts: {
    sweep?: () => Promise<unknown>;
    scan?: () => Promise<ScanResult>;
    drain?: () => Promise<{ failed: number }>;
    labelSync?: () => Promise<{ failed: number }>;
    abandon?: () => Promise<{ failed: number }>;
    ping?: (url: string) => Promise<void>;
    checkUrl?: string | undefined;
  } = {},
) {
  const { logger, lines } = makeCapturingLogger();
  const config = makeTestConfig({
    RECONCILIATION_CHECK_URL: 'checkUrl' in opts ? opts.checkUrl : CHECK_URL,
  });
  const runSweep = vi.fn(opts.sweep ?? (() => Promise.resolve()));
  const runScan = vi.fn(opts.scan ?? (() => Promise.resolve(scanResult())));
  const runDrain = vi.fn(opts.drain ?? (() => Promise.resolve({ failed: 0 })));
  const runLabelSync = vi.fn(opts.labelSync ?? (() => Promise.resolve({ failed: 0 })));
  const runAbandon = vi.fn(opts.abandon ?? (() => Promise.resolve({ failed: 0 })));
  const ping = vi.fn(opts.ping ?? ((_url: string) => Promise.resolve()));
  const onSweepError = vi.fn((_err: unknown) => Promise.resolve());
  return {
    deps: {
      config,
      logger,
      runSweep,
      runScan,
      runDrain,
      runLabelSync,
      runAbandon,
      ping,
      onSweepError,
    },
    lines,
    runSweep,
    runScan,
    runDrain,
    runLabelSync,
    runAbandon,
    ping,
    onSweepError,
  };
}

describe('runReconciliationCron (Task 6.1 fold)', () => {
  it('pings its own check exactly once after BOTH duties succeed', async () => {
    const h = makeDeps();

    await runReconciliationCron(h.deps);

    expect(h.runSweep).toHaveBeenCalledTimes(1);
    expect(h.runScan).toHaveBeenCalledTimes(1);
    expect(h.ping).toHaveBeenCalledTimes(1);
    expect(h.ping).toHaveBeenCalledWith(CHECK_URL);
    expect(h.onSweepError).not.toHaveBeenCalled();
  });

  it('runs the SLA scan even when the sweep fails, then withholds the ping and throws', async () => {
    const boom = new Error('dialpad down');
    const h = makeDeps({
      sweep: () => Promise.reject(boom),
      scan: () => Promise.resolve(scanResult({ escalated: 1 })),
    });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.onSweepError).toHaveBeenCalledWith(boom);
    expect(h.runScan).toHaveBeenCalledTimes(1); // scan attempted despite the sweep failure
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('runs the SLA scan even when the sweep AND the error handler both throw', async () => {
    const h = makeDeps({
      sweep: () => Promise.reject(new Error('dialpad down')),
      scan: () => Promise.resolve(scanResult({ escalated: 1 })),
    });
    h.deps.onSweepError = vi.fn(() => Promise.reject(new Error('alert mapping blew up')));

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    // The scan still ran despite the error handler throwing; the ping is still withheld.
    expect(h.runScan).toHaveBeenCalledTimes(1);
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('sweep error handler failed'))).toBe(true);
  });

  it('withholds the ping and throws when the scan reports failed rows', async () => {
    const h = makeDeps({ scan: () => Promise.resolve(scanResult({ failed: 1 })) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('withholds the ping and throws when the scan reports locked-skipped rows', async () => {
    const h = makeDeps({ scan: () => Promise.resolve(scanResult({ lockedSkipped: 1 })) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('withholds the ping and throws when the scan itself throws', async () => {
    const h = makeDeps({ scan: () => Promise.reject(new Error('scan boom')) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.onSweepError).not.toHaveBeenCalled(); // sweep was fine
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('runs the reprocess drain and pings when it is complete', async () => {
    const h = makeDeps({ drain: () => Promise.resolve({ failed: 0 }) });

    await runReconciliationCron(h.deps);

    expect(h.runDrain).toHaveBeenCalledTimes(1);
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it('withholds the ping and throws when the reprocess drain is incomplete', async () => {
    const h = makeDeps({ drain: () => Promise.resolve({ failed: 1 }) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.runDrain).toHaveBeenCalledTimes(1);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('withholds the ping and throws when the reprocess drain itself throws', async () => {
    const h = makeDeps({ drain: () => Promise.reject(new Error('drain boom')) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('runs the label-sync duty and pings when it is healthy', async () => {
    const h = makeDeps({ labelSync: () => Promise.resolve({ failed: 0 }) });

    await runReconciliationCron(h.deps);

    expect(h.runLabelSync).toHaveBeenCalledTimes(1);
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it('withholds the ping and throws when label-sync reports an operational failure', async () => {
    const h = makeDeps({ labelSync: () => Promise.resolve({ failed: 2 }) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.runLabelSync).toHaveBeenCalledTimes(1);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('withholds the ping and throws when label-sync itself throws', async () => {
    const h = makeDeps({ labelSync: () => Promise.reject(new Error('sync boom')) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('runs the transcript-hold auto-close duty and pings when it is healthy', async () => {
    const h = makeDeps({ abandon: () => Promise.resolve({ failed: 0 }) });

    await runReconciliationCron(h.deps);

    expect(h.runAbandon).toHaveBeenCalledTimes(1);
    expect(h.ping).toHaveBeenCalledTimes(1);
  });

  it('withholds the ping and throws when the auto-close reports a failure', async () => {
    // A failed Dialpad re-check must never look healthy: closing nothing is correct, but going
    // green would hide that the duty is not actually running.
    const h = makeDeps({ abandon: () => Promise.resolve({ failed: 1 }) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('withholds the ping and throws when the auto-close itself throws', async () => {
    const h = makeDeps({ abandon: () => Promise.reject(new Error('abandon boom')) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.ping).not.toHaveBeenCalled();
  });

  it('still runs the auto-close when the sweep failed (duties are independent)', async () => {
    const h = makeDeps({ sweep: () => Promise.reject(new Error('dialpad down')) });

    await expect(runReconciliationCron(h.deps)).rejects.toThrow(/duty failed/);
    expect(h.runAbandon).toHaveBeenCalledTimes(1);
  });

  it('skips the ping without throwing when no check URL is configured (both duties ok)', async () => {
    const h = makeDeps({ checkUrl: undefined });

    await expect(runReconciliationCron(h.deps)).resolves.toBeUndefined();
    expect(h.ping).not.toHaveBeenCalled(); // pingSuccess no-ops on an undefined URL
  });

  it('a ping transport failure is logged but does not fail the run', async () => {
    const h = makeDeps({ ping: () => Promise.reject(new Error('monitor unreachable')) });

    await expect(runReconciliationCron(h.deps)).resolves.toBeUndefined();
    expect(h.lines.some((l) => l.includes('external check ping failed'))).toBe(true);
  });
});
