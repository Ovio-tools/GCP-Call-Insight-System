import { describe, expect, it } from 'vitest';
import { type FailureFields, createFailure, dedupKey } from '../../src/failure-model/index.js';

function withContext(context: Record<string, string>): FailureFields {
  return createFailure('DIALPAD_RATE_LIMITED', { processingState: 'degraded', context });
}

describe('dedupKey', () => {
  it('collapses identical repeated failures to one key', () => {
    const a = dedupKey(withContext({ call_id: 'c-1' }));
    const b = dedupKey(withContext({ call_id: 'c-1' }));
    expect(a).toBe(b);
    expect(a).toBe('DIALPAD_RATE_LIMITED:call_id:c-1');
  });

  it('separates different scopes and different codes', () => {
    expect(dedupKey(withContext({ call_id: 'c-1' }))).not.toBe(
      dedupKey(withContext({ call_id: 'c-2' })),
    );
    expect(
      dedupKey(
        createFailure('MODEL_RATE_LIMITED', {
          processingState: 'degraded',
          context: { call_id: 'c-1' },
        }),
      ),
    ).not.toBe(dedupKey(withContext({ call_id: 'c-1' })));
  });

  it('embeds the scope key so same value on different keys does not collide', () => {
    expect(dedupKey(withContext({ call_id: 'abc' }))).not.toBe(
      dedupKey(withContext({ job_id: 'abc' })),
    );
  });

  it('respects the scope priority order (call_id before job_id)', () => {
    expect(dedupKey(withContext({ job_id: 'j-1', call_id: 'c-1' }))).toBe(
      'DIALPAD_RATE_LIMITED:call_id:c-1',
    );
  });

  it('falls back to global when no scope key is present', () => {
    expect(dedupKey(withContext({}))).toBe('DIALPAD_RATE_LIMITED:global');
  });

  it('sanitizes a hand-built FailureFields — unsafe/unknown/content keys never contribute', () => {
    const base = createFailure('DIALPAD_RATE_LIMITED', { processingState: 'degraded' });
    const handBuilt: FailureFields = {
      ...base,
      context: {
        transcript: 'SECRET',
        notes: 'free',
        stage: 'not-a-stage',
        environment: 'nope',
      },
    };
    // Nothing survives sanitization -> global.
    expect(dedupKey(handBuilt)).toBe('DIALPAD_RATE_LIMITED:global');
  });

  it('throws on a content-like / invalid error_code', () => {
    const base = createFailure('DIALPAD_RATE_LIMITED', { processingState: 'degraded' });
    const bad = { ...base, error_code: 'CUSTOMER_PHONE_415' } as unknown as FailureFields;
    expect(() => dedupKey(bad)).toThrow();
  });
});
