import { createFailure, type ErrorCode, type FailureError } from '../failure-model/index.js';

/**
 * Build a middleware failure with a consistent, PII-free context. `environment` is the only
 * context value (a validated NODE_ENV); request bodies, headers, tokens, and identifiers
 * never enter the failure object.
 */
export function httpFailure(code: ErrorCode, environment: string): FailureError {
  return createFailure(code, {
    processingState: 'continuing',
    context: { environment },
  });
}
