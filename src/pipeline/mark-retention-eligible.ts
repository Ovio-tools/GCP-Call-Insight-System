import type { Pool } from 'pg';
import { markTranscriptRetentionEligible } from '../db/repositories/raw-transcripts-repo.js';
import {
  type RestrictedRunner,
  createRestrictedRunner,
} from '../db/restricted/restricted-context.js';
import { markTokensRetentionEligible } from '../db/restricted/token-vault-repo.js';
import type { StageContext, StageHandler, StageResult } from './stages.js';

/**
 * The `mark-retention-eligible` stage handler (Task 5.3) — the FINAL pipeline stage. Once
 * the de-identified record is durable in structured_knowledge (the previous `store` stage),
 * the sensitive source is no longer needed: this stamps `retention_eligible_at` on the raw
 * transcript and every vault row for the call so the scheduled retention cron (Task 8.x) may
 * purge them after their windows pass. It DELETES NOTHING — deletion never lives on the
 * per-call path (§5). Returning `continue` from this last stage is what advances call_state
 * to `completed`.
 *
 * This stage touches raw_transcripts (app_role) and token_vault (restricted_role, via the
 * restricted runner). It is on the model-stage import-guard allowlist because it legitimately
 * addresses those tables — but only their retention METADATA: it never decrypts, never reads
 * transcript text, and never touches a token→value mapping.
 *
 * Idempotent + crash-safe: both stamps are monotonic (only an unstamped, non-hard-deleted
 * row is touched), so a crash between the two stamps — or a re-run of this stage — never
 * resets a purge clock and never deletes anything. The raw stamp runs first, then the vault
 * stamp; either order is safe because a retry re-enters this stage and re-applies the
 * remaining stamp.
 */
export interface MarkRetentionEligibleDeps {
  /** DB-B app pool (Task 8a): raw_transcripts + token_vault live only in the raw store. */
  rawPool: Pool;
  /** Test injection. Default: createRestrictedRunner (the audited restricted-role choke point). */
  makeRestrictedRunner?: (pool: Pool) => RestrictedRunner;
}

export function createMarkRetentionEligibleHandler(deps: MarkRetentionEligibleDeps): StageHandler {
  const makeRunner = deps.makeRestrictedRunner ?? createRestrictedRunner;

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger } = ctx;

    // Raw transcript first (app_role), then the vault (restricted_role). Both monotonic +
    // hard-delete-guarded, so partial completion + retry is safe and never re-stamps.
    await markTranscriptRetentionEligible(deps.rawPool, callId);
    await markTokensRetentionEligible(makeRunner(deps.rawPool), callId);

    logger.info({ stage }, 'marked raw transcript + vault retention-eligible — completing');
    return { action: 'continue' };
  };
}
