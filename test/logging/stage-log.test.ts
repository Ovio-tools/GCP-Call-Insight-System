import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRootLogger } from '../../src/logging/logger.js';
import { logStageFailure, logStageStart, logStageSuccess } from '../../src/logging/stage-log.js';

function capture(): { lines: string[]; logger: ReturnType<typeof createRootLogger> } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createRootLogger({ level: 'debug', destination: stream }) };
}

const parse = (lines: string[]): Record<string, unknown>[] =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('stage structured logging', () => {
  it('logs a start line with call_id, stage and a start event marker', () => {
    const { lines, logger } = capture();
    logStageStart(logger, { callId: 'call-1', stage: 'classify' });
    const [rec] = parse(lines);
    expect(rec).toMatchObject({
      call_id: 'call-1',
      stage: 'classify',
      event: 'stage_start',
      outcome: 'started',
    });
  });

  it('logs a success line with call_id, outcome and duration', () => {
    const { lines, logger } = capture();
    logStageSuccess(logger, {
      callId: 'call-1',
      stage: 'classify',
      outcome: 'completed',
      durationMs: 12,
    });
    const [rec] = parse(lines);
    expect(rec).toMatchObject({
      call_id: 'call-1',
      stage: 'classify',
      event: 'stage_end',
      outcome: 'completed',
      duration_ms: 12,
    });
    expect(rec?.level).toBe(30); // info
  });

  it('logs a failure line at warn level with call_id, error_code, outcome, and attempt/job id', () => {
    const { lines, logger } = capture();
    logStageFailure(logger, {
      callId: 'call-1',
      stage: 'extract',
      outcome: 'held',
      errorCode: 'MODEL_MALFORMED_RESPONSE',
      durationMs: 3,
      attempt: 2,
      jobId: 'call-abc',
    });
    const [rec] = parse(lines);
    expect(rec).toMatchObject({
      call_id: 'call-1',
      stage: 'extract',
      event: 'stage_end',
      outcome: 'held',
      error_code: 'MODEL_MALFORMED_RESPONSE',
      duration_ms: 3,
      attempt: 2,
      job_id: 'call-abc',
    });
    expect(rec?.level).toBe(40); // warn
  });

  it('always emits call_id even when the logger is a root logger (no child binding)', () => {
    const { lines, logger } = capture();
    for (const outcome of ['completed', 'skipped', 'held', 'deferred', 'failed'] as const) {
      logStageFailure(logger, { callId: 'call-xyz', stage: 'redact', outcome });
    }
    for (const rec of parse(lines)) {
      expect(rec.call_id).toBe('call-xyz');
    }
  });
});
