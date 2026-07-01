import {
  type CallsState,
  type ErrorCode,
  type ProcessingState,
  ERROR_CODES,
  catalogFor,
  createFailure,
  type FailureError,
} from '../../../src/failure-model/index.js';

/** A deterministic processing-state per calls-state, so samples are stable. */
const PROCESSING_BY_CALLS: Record<CallsState, ProcessingState> = {
  held: 'paused',
  retried: 'degraded',
  dropped: 'paused',
  none: 'continuing',
};

/**
 * One representative `FailureError` per code. Context is populated with identifiers only:
 * call-scoped codes carry a `call_id`; infra codes with no in-flight call carry a
 * `component` instead. Used by the golden-alert and completeness tests.
 */
export function sampleFailureFor(code: ErrorCode): FailureError {
  const entry = catalogFor(code);
  const processingState = PROCESSING_BY_CALLS[entry.callsState];
  const context =
    entry.callsState === 'none'
      ? { environment: 'staging', component: 'worker' }
      : { call_id: 'c-1', environment: 'staging' };
  return createFailure(code, { processingState, context });
}

/** Fixed options so golden alerts are deterministic. */
export const GOLDEN_OPTS = {
  environment: 'staging',
  timestamp: '2026-01-01T00:00:00.000Z',
} as const;

/** Every code, for iteration in tests. */
export const ALL_CODES: readonly ErrorCode[] = ERROR_CODES;
