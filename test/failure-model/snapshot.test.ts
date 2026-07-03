import { describe, expect, it } from 'vitest';
import { assertNoContentFields } from '../../src/logging/redaction.js';
import { catalogFor, createFailure, failureSnapshot } from '../../src/failure-model/index.js';

describe('failureSnapshot', () => {
  it('serializes every §4 field from a FailureError', () => {
    const failure = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      context: { call_id: 'call-1', stage: 'fetch-transcript', environment: 'test' },
    });
    const entry = catalogFor('DIALPAD_RATE_LIMITED');

    const snapshot = failureSnapshot(failure);

    expect(snapshot).toEqual({
      error_code: 'DIALPAD_RATE_LIMITED',
      root_cause_category: 'DIALPAD_RATE_LIMITED',
      severity: failure.severity,
      impact: entry.impact,
      processing_state: 'degraded',
      remediation_now: entry.remediationNow,
      remediation_fix: entry.remediationFix,
      data_safe: entry.dataSafe,
      calls_state: entry.callsState,
      owner: entry.owner,
      runbook_ref: entry.runbookRef,
      context: { call_id: 'call-1', stage: 'fetch-transcript', environment: 'test' },
    });
  });

  it('carries only the sanitized (allowlisted) context — content/unknown keys are dropped upstream', () => {
    const failure = createFailure('MODEL_MALFORMED_RESPONSE', {
      processingState: 'continuing',
      // `transcript` is a content field and `bucket` is not allowlisted: both must be gone.
      context: {
        call_id: 'call-2',
        transcript: 'raw customer words',
        bucket: 'customer',
      },
    });

    const snapshot = failureSnapshot(failure);

    expect(snapshot.context).toEqual({ call_id: 'call-2' });
    // Belt-and-suspenders: the serialized snapshot survives the content-field egress guard.
    expect(() => assertNoContentFields(snapshot)).not.toThrow();
  });
});
