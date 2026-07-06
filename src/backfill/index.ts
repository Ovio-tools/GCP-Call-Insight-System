/**
 * Historical backfill runner (Task 11.2): pulls concluded historical calls that predate deployment
 * through the SAME idempotent seed → shared pipeline path, heavily gated (§0.2 consent gates,
 * production-only real mode / staging-only synthetic), fully resumable + idempotent, watched by a
 * four-signal job monitor. See `docs/backfill.md`.
 */
export { BackfillError, type BackfillRefusalReason } from './errors.js';
export { assertBackfillEnvironment, type BackfillMode } from './guards.js';
export {
  assertBackfillProcessingGates,
  deriveServiceTitanMatchingRequirement,
  type BackfillExecOptions,
} from './gates.js';
export {
  BACKFILL_SOURCE,
  BACKFILL_SYNTHETIC_SOURCE,
  createPgBackfillInlineIngest,
  createPgBackfillQueueIngest,
  type BackfillIngest,
} from './ingest.js';
export {
  createSyntheticDialpadClient,
  loadSyntheticDialpadFixture,
  type SyntheticDialpadFixture,
} from './synthetic-dialpad.js';
export {
  advanceWatermark,
  decodeCheckpoint,
  encodeCheckpoint,
  pageStartedAtFailure,
  shouldSkip,
  type BackfillCheckpoint,
} from './checkpoint.js';
export { callMembership, computeSince, type WindowBounds } from './window.js';
export {
  TERMINAL_CALL_STATE_STATUSES,
  countNonTerminalTrackedCalls,
  isCallTerminal,
} from './terminal.js';
export {
  BACKFILL_ADVISORY_LOCK_KEY,
  runBackfill,
  type RunBackfillDeps,
  type RunBackfillResult,
} from './run.js';
