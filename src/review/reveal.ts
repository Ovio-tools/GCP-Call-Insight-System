import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import type { RestrictedRunner } from '../db/restricted/restricted-context.js';
import { query, withTransaction } from '../db/sql.js';
import { recordOperatorAction } from '../db/repositories/operator-actions-repo.js';
import { getTranscript, transcriptExists } from '../db/repositories/raw-transcripts-repo.js';
import { getToken, tokenExistsForCall } from '../db/restricted/token-vault-repo.js';
import { rawTranscriptRevealAllowed } from './raw-access.js';
import { ReviewConflictError, ReviewNotFoundError } from './errors.js';

export interface PerformRevealInput {
  pool: Pool;
  runner: RestrictedRunner;
  keyProvider: KeyProvider;
  config: Config;
  now: Date;
  logger: Logger;
  reviewId: string;
  /** Optional single vault token LABEL to also decrypt (validated syntactically upstream). */
  token?: string;
  actor: string;
}

export type RevealResult =
  | { raw_available: false }
  | { raw_available: true; transcript: string; vault_value?: string; vault_token_ref?: string };

/**
 * The elevated raw/vault reveal (Task 6.2, plan §"reveal"). The caller has already asserted the
 * session is an elevated reviewer (`requireElevatedReviewer`). Reveals the raw transcript for
 * THIS call only, plus at most one vault value; writes exactly one `reveal_raw` audit row whose
 * sanitized `after` reflects what was actually revealed (field names + call_id + token LABEL —
 * NEVER the decrypted value). Raw crosses to the reviewer in the RESPONSE BODY only, never a log.
 *
 * If the retention window is closed / raw is purged / the transcript is missing, returns
 * `{raw_available:false}` with NO audit row (redacted-only resolution still works).
 */
export async function performReveal(input: PerformRevealInput): Promise<RevealResult> {
  const { pool, config, now, reviewId, token, actor } = input;

  // The active-review check, the availability check, and the audit write must be atomic: lock the
  // review row FOR UPDATE for the whole reveal window so a concurrent action (which also locks the
  // review by id) cannot resolve it in between and let raw/vault be revealed against a now-terminal
  // review. Mirrors performReviewAction's one-tx handler.
  return withTransaction(pool, async (client) => {
    const revRows = await query<{
      status: string;
      call_id: string;
      raw_purged_at: Date | null;
      created_at: Date;
    }>(
      client,
      `SELECT status, call_id, raw_purged_at, created_at
         FROM review_queue WHERE id = $1 FOR UPDATE`,
      [reviewId],
    );
    const review = revRows[0];
    if (!review) throw new ReviewNotFoundError();
    // Reveal is for a held call under active review.
    if (review.status !== 'open' && review.status !== 'in_review') throw new ReviewConflictError();
    const callId = review.call_id;

    const present = await transcriptExists(client, callId);
    if (!rawTranscriptRevealAllowed(review, now, config, present)) {
      // Purged, past the time-based cap (even with raw_purged_at still null), or transcript missing:
      // no decrypt, no audit row.
      return { raw_available: false };
    }

    const transcript = await getTranscript(client, input.keyProvider, callId);
    if (transcript === undefined) {
      // Raced with a purge between the existence check and the read — treat as unavailable.
      return { raw_available: false };
    }

    let vaultValue: string | undefined;
    if (token !== undefined) {
      // Reject a token that does not belong to THIS call BEFORE decrypting — no cross-call pivot.
      // The restricted vault reads run on their own connection but the review row stays locked by
      // this tx throughout, so the reveal still cannot outlive an active review.
      const belongs = await tokenExistsForCall(input.runner, { callId, token });
      if (!belongs) throw new ReviewConflictError('Token does not belong to this call.');
      const plaintext = await getToken(input.runner, input.keyProvider, { callId, token });
      if (plaintext === undefined) throw new ReviewConflictError('Token not available.');
      vaultValue = plaintext.toString('utf8');
    }

    // Exactly one reveal_raw audit row; `after` reflects what was revealed, never the value.
    const after =
      token !== undefined
        ? { revealed: ['transcript', 'vault_value'], call_id: callId, vault_token_ref: token }
        : { revealed: ['transcript'], call_id: callId };
    await recordOperatorAction(client, {
      reviewQueueId: reviewId,
      actor,
      action: 'reveal_raw',
      before: null,
      after,
    });

    if (token !== undefined && vaultValue !== undefined) {
      return { raw_available: true, transcript, vault_value: vaultValue, vault_token_ref: token };
    }
    return { raw_available: true, transcript };
  });
}
