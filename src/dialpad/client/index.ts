/**
 * Dialpad transcript client (Task 3.3): fetches AI transcripts for the fetch-transcript
 * stage and lists recently-concluded calls for the reconciliation sweep. Honors Dialpad's
 * two rate limits via a shared limiter, retries transient failures, and surfaces typed
 * PII-free errors the caller maps to the shared failure model.
 */
export { createDialpadClient } from './client.js';
export type {
  DialpadClient,
  TranscriptResult,
  RecentCall,
  RecentCallsPage,
  CreateDialpadClientOptions,
} from './client.js';
export { DialpadError, isRetryableDialpadError } from './errors.js';
export type { DialpadFailureKind } from './errors.js';
export { MemoryLimiter, RedisDualWindowLimiter, realLimiterClock } from './limiter.js';
export type { Limiter, DualWindowLimits, LimiterClock } from './limiter.js';
export { buildDialpadAuthHeaders, requireDialpadApiKey } from './auth.js';
export {
  transcriptResponseSchema,
  recentCallsResponseSchema,
  classifyTranscript,
} from './schemas.js';
export type { TranscriptReadiness } from './schemas.js';
