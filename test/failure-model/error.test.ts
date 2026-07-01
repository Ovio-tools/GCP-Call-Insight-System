import { describe, expect, it } from 'vitest';
import {
  type ErrorCode,
  type FailureFields,
  FailureError,
  MAX_CONTEXT_VALUE_LENGTH,
  createFailure,
} from '../../src/failure-model/index.js';

/** A valid FailureFields object for a known code, for consistency/override tests. */
function validFields(): FailureFields {
  const base = createFailure('DIALPAD_RATE_LIMITED', {
    processingState: 'degraded',
    context: { call_id: 'c-1' },
  });
  return {
    error_code: base.error_code,
    root_cause_category: base.root_cause_category,
    severity: base.severity,
    impact: base.impact,
    processing_state: base.processing_state,
    remediation_now: base.remediation_now,
    remediation_fix: base.remediation_fix,
    data_safe: base.data_safe,
    calls_state: base.calls_state,
    owner: base.owner,
    runbook_ref: base.runbook_ref,
    context: base.context,
  };
}

describe('sanitizeContext (via createFailure)', () => {
  const SECRET = 'SECRET_TRANSCRIPT_TEXT';
  const PHONE = '+1-415-555-9999';

  const err = createFailure('DIALPAD_RATE_LIMITED', {
    processingState: 'degraded',
    context: {
      transcript: SECRET,
      customer_phone: PHONE,
      notes: 'free text',
      call_id: ' c-1 ',
      job_id: '',
      environment: 'staging',
      component: 'bogus',
      stage: 'not-a-stage',
    },
  });

  it('keeps only allowlisted, valid keys — content/unknown/invalid-enum dropped', () => {
    expect(err.context).toEqual({ call_id: 'c-1', environment: 'staging' });
  });

  it('never carries content values anywhere on the error', () => {
    const serialized = JSON.stringify({
      context: err.context,
      message: err.message,
    });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PHONE);
  });

  it('trims call_id/job_id and drops empty / whitespace-only', () => {
    const make = (call_id: string): Record<string, string> =>
      createFailure('DIALPAD_RATE_LIMITED', {
        processingState: 'degraded',
        context: { call_id },
      }).context;

    expect(make(' c-1 ')).toEqual({ call_id: 'c-1' });
    expect(make('')).toEqual({});
    expect(make('   ')).toEqual({});
  });

  it('drops an over-length call_id/job_id', () => {
    const tooLong = 'x'.repeat(MAX_CONTEXT_VALUE_LENGTH + 1);
    const ctx = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      context: { call_id: tooLong, job_id: tooLong },
    }).context;
    expect(ctx).toEqual({});
  });
});

describe('FailureError', () => {
  it('exposes .code as an alias of error_code', () => {
    const err = createFailure('DIALPAD_RATE_LIMITED', { processingState: 'degraded' });
    expect(err.code).toBe('DIALPAD_RATE_LIMITED');
    expect(err.error_code).toBe('DIALPAD_RATE_LIMITED');
  });

  it('has a message of `${error_code}: ${impact}` and takes no caller message', () => {
    const err = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      context: { call_id: 'c-1' },
    });
    expect(err.message).toBe(`${err.error_code}: ${err.impact}`);
    expect(err.message).not.toContain('c-1');
  });

  it('parses via the schema — malformed enum fields are rejected', () => {
    expect(() => new FailureError({ ...validFields(), severity: 'bogus' as never })).toThrow();
    expect(() => new FailureError({ ...validFields(), calls_state: 'bogus' as never })).toThrow();
    expect(
      () => new FailureError({ ...validFields(), processing_state: 'bogus' as never }),
    ).toThrow();
  });

  it('enforces catalog consistency (severity exempt)', () => {
    // Mismatched root_cause_category throws.
    expect(
      () => new FailureError({ ...validFields(), root_cause_category: 'MODEL_AUTH_FAILED' }),
    ).toThrow();
    // Mismatched impact throws.
    expect(() => new FailureError({ ...validFields(), impact: 'wrong impact' })).toThrow();
    // Severity override does NOT throw.
    expect(() => new FailureError({ ...validFields(), severity: 'critical' })).not.toThrow();
  });
});

describe('createFailure', () => {
  it('throws on an unknown code (catalog/severity miss)', () => {
    expect(() =>
      createFailure('UNKNOWN' as ErrorCode, { processingState: 'continuing' }),
    ).toThrow();
  });

  it('applies a severity override', () => {
    const err = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      severity: 'critical',
    });
    expect(err.severity).toBe('critical');
  });
});
