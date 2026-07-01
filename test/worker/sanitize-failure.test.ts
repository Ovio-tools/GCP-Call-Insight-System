import { describe, expect, it } from 'vitest';
import { PipelineStageError } from '../../src/pipeline/errors.js';
import { sanitizeFailure, type FailedJobLike } from '../../src/worker/errors.js';

const job: FailedJobLike = { id: 'job-1', attemptsMade: 3, data: { callId: 'test-call' } };

/** Build an error with a planted, unsafe name/code (as if a future stage leaked content). */
function taintedError(): Error {
  const err = new Error('raw message with 555-123-4567 and jane@example.com');
  err.name = 'Leak 555-123-4567';
  (err as Error & { code: string }).code = 'secret jane@example.com';
  return err;
}

describe('sanitizeFailure (fail-closed)', () => {
  it('drops an unsafe error name/code and never persists the raw message', () => {
    const { shortMessage, snapshot } = sanitizeFailure(job, taintedError());

    expect(snapshot.error_name).toBe('Error'); // unsafe name rejected → generic
    expect(snapshot.error_code).toBeUndefined(); // unsafe code omitted, not guessed
    const serialized = `${shortMessage} ${JSON.stringify(snapshot)}`;
    expect(serialized).not.toMatch(/555-123-4567/);
    expect(serialized).not.toMatch(/jane@example.com/);
    expect(serialized).not.toMatch(/raw message/);
  });

  it('sanitizes the wrapped cause of a PipelineStageError too', () => {
    const wrapped = sanitizeFailure(
      job,
      new PipelineStageError('redact', 'test-call', taintedError()),
    );

    expect(wrapped.failedStage).toBe('redact');
    expect(wrapped.snapshot.error_name).toBe('Error');
    expect(wrapped.snapshot.error_code).toBeUndefined();
    expect(JSON.stringify(wrapped.snapshot)).not.toMatch(/jane@example.com/);
  });

  it('preserves safe identifier-shaped name and code', () => {
    const safe = new Error('x');
    safe.name = 'DalError';
    (safe as Error & { code: string }).code = 'DAL_STALE_STAGE';

    const { snapshot } = sanitizeFailure(
      job,
      new PipelineStageError('classify', 'test-call', safe),
    );

    expect(snapshot.error_name).toBe('DalError');
    expect(snapshot.error_code).toBe('DAL_STALE_STAGE');
  });
});
