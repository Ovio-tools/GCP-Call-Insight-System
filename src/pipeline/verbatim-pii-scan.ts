import type { Config } from '../config/schema.js';
import type { JsonValue } from '../db/types.js';
import type { PiiScanFailureKind } from '../db/enums.js';
import {
  getExtractionCandidate,
  markPiiScanFailed,
  markPiiScanPassed,
} from '../db/repositories/extraction-candidates-repo.js';
import { getCleanTranscript } from '../db/repositories/clean-transcripts-repo.js';
import { loadDenyList } from '../redaction/deny-list.js';
import {
  recordStageAlert,
  recordVerbatimPiiDetectedAlertResilient,
  resilientSideEffect,
} from './model-stage-shared.js';
import { scanPhrasesForResidual, tokenGate, verbatimGate } from './extract/gates.js';
import type { PipelineStage, StageContext, StageHandler, StageResult } from './stages.js';

/**
 * The `verbatim-pii-scan` stage handler (Task 5.2 M6). Defense in depth: it runs AFTER the
 * `extract` stage and re-verifies the PERSISTED `extraction_candidates` row so a candidate can
 * reach `pii_scan_status='passed'` ONLY by passing (a) the residual-PII scan, (b) the token
 * gate, and (c) the verbatim recheck against the clean transcript. It defends against a bad
 * deploy skipping extract's in-memory gate, a manual row edit, or a deny-list update between
 * runs. It makes NO model call, has NO cost and NO kill switch, and is CRASH-SAFE: a detected
 * hit latches the failed marker (scrubbing `customer_language` to `[]` in one statement) so the
 * hold is re-returnable — it can never dead-letter and never lose its alert.
 *
 * Privacy: no phrase text or extracted field ever reaches a log line, an alert snapshot, a
 * processing_log detail, or a review_queue row — only counts, booleans, the constant gate id,
 * and `phrases_scanned` (a number). This handler NEVER writes `review_queue` or `call_state`;
 * it only returns a {@link StageResult}. The runner's `holdCall` creates the review row.
 */
export interface VerbatimPiiScanHandlerDeps {
  config: Config;
  /** Deny terms; when absent they are loaded ONCE at construction from config (below). A bad
   * deny-list config must fail CONSTRUCTION, never a per-call retry loop. */
  denyTerms?: readonly string[];
}

export function createVerbatimPiiScanHandler(deps: VerbatimPiiScanHandlerDeps): StageHandler {
  // A bad deny-list config fails CONSTRUCTION (ConfigError) — identical to createExtractHandler.
  const denyTerms = deps.denyTerms ?? loadDenyList(deps.config.REDACTION_DENY_LIST_PATH);
  const config = deps.config;

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger, pool } = ctx;

    // 1. Load the persisted candidate. Absence is an invariant break (extract advanced without a
    //    live candidate) → throw → retry → dead-letter. Never log any phrase.
    const candidate = await getExtractionCandidate(pool, callId);
    if (!candidate) {
      throw new Error(
        `extraction_candidates row for ${callId} is missing at verbatim-pii-scan — ` +
          `extract advanced without a live candidate`,
      );
    }

    // 2. Idempotent failed-marker fast path. A prior run already scrubbed the phrases to [] and
    //    latched the marker; re-apply the SAME hold (re-recording/deduping the alert) without a
    //    re-scan. This is the crash-recovery guarantee: a crash after the marker write but before
    //    holdCall re-enters here and re-returns the same hold until the review row exists.
    if (candidate.pii_scan_status === 'failed') {
      return failedMarkerHold(
        pool,
        callId,
        stage,
        config,
        logger,
        candidate.pii_scan_failure_kind,
        candidate.pii_scan_counts,
      );
    }

    // 3. Load the clean transcript — needed for the verbatim recheck. Absence is an invariant
    //    break → throw.
    const clean = await getCleanTranscript(pool, callId);
    if (!clean) {
      throw new Error(
        `clean_transcripts row for ${callId} is missing at verbatim-pii-scan — invariant break`,
      );
    }

    const phrases = candidate.customer_language;

    // 4. Residual scan (PII precedence, FIRST) — reuses the SAME audited counts-only merge as
    //    the extract gate (scanPhrasesForResidual). Never phrase text.
    const scan = scanPhrasesForResidual(phrases, denyTerms);

    // 5. Residual hit → latch the failure (ONE atomic UPDATE scrubs customer_language + marks
    //    failed), THEN record the resilient deduped alert, THEN return the hold regardless of
    //    alert success. The detail shape matches the extract handler's residual hold.
    if (scan.hit) {
      await markPiiScanFailed(pool, callId, { kind: 'residual_pii', counts: scan.counts });
      await recordVerbatimPiiDetectedAlertResilient(
        pool,
        callId,
        stage,
        config,
        scan.counts,
        logger,
      );
      logger.info(
        { stage, residual_categories: Object.keys(scan.counts) },
        'verbatim-pii-scan residual-PII hit in persisted customer_language — holding residual_pii_detected',
      );
      return {
        action: 'hold',
        reason: 'residual_pii_detected',
        errorCode: 'VERBATIM_PII_DETECTED',
        detail: { residual_categories: Object.keys(scan.counts), counts: scan.counts },
      };
    }

    // 6. Token gate on persisted phrases — any tokened (dropped) phrase is output badness that
    //    reached persistence → latch tokened_phrase → schema_invalid hold.
    const gated = tokenGate(phrases);
    if (gated.droppedCount > 0) {
      await markPiiScanFailed(pool, callId, {
        kind: 'tokened_phrase',
        dropped_count: gated.droppedCount,
      });
      return malformedHold(pool, callId, stage, config, logger, 'tokened_phrase', {
        dropped_count: gated.droppedCount,
      });
    }

    // 7. Verbatim recheck — every persisted phrase must appear (light-normalized) in the clean
    //    transcript. A reconstructed/paraphrased phrase → latch verbatim_mismatch → schema_invalid.
    const vb = verbatimGate(phrases, clean.redacted_text);
    if (!vb.ok) {
      await markPiiScanFailed(pool, callId, {
        kind: 'verbatim_mismatch',
        mismatch_count: vb.mismatchCount,
        phrase_count: vb.phraseCount,
      });
      return malformedHold(pool, callId, stage, config, logger, 'verbatim_mismatch', {
        mismatch_count: vb.mismatchCount,
        phrase_count: vb.phraseCount,
      });
    }

    // 8. Clean → conditionally latch passed (only from 'pending'; the failed marker is a one-way
    //    latch). A row means the pass won; undefined means zero rows updated — re-read and decide.
    const passed = await markPiiScanPassed(pool, callId);
    if (passed) {
      logger.info(
        { stage, phrases_scanned: phrases.length },
        'verbatim-pii-scan passed — advancing',
      );
      return { action: 'continue', detail: { phrases_scanned: phrases.length } };
    }

    const reread = await getExtractionCandidate(pool, callId);
    if (!reread) {
      throw new Error(
        `extraction_candidates row for ${callId} vanished during verbatim-pii-scan pass — invariant break`,
      );
    }
    if (reread.pii_scan_status === 'failed') {
      // A concurrent fail landed first (e.g. a deny-list re-scan): failing always wins.
      return failedMarkerHold(
        pool,
        callId,
        stage,
        config,
        logger,
        reread.pii_scan_failure_kind,
        reread.pii_scan_counts,
      );
    }
    if (reread.pii_scan_status === 'passed') {
      // A concurrent run already passed it — idempotent continue.
      return { action: 'continue', detail: { phrases_scanned: phrases.length } };
    }
    throw new Error(
      `verbatim-pii-scan: pass for ${callId} matched zero rows but status is ` +
        `'${reread.pii_scan_status}' — inconsistent`,
    );
  };
}

/**
 * Map a latched failed marker to its hold, from the stored/known kind + counts. Alert side
 * effects never block the hold. Used by the step-2 fast path, the step-8 re-read, and (via the
 * kind just written) the residual path is handled inline above.
 */
async function failedMarkerHold(
  pool: StageContext['pool'],
  callId: string,
  stage: PipelineStage,
  config: Config,
  logger: StageContext['logger'],
  kind: PiiScanFailureKind | null,
  counts: Record<string, number> | null,
): Promise<StageResult> {
  if (kind === 'residual_pii') {
    const c = counts ?? {};
    await recordVerbatimPiiDetectedAlertResilient(pool, callId, stage, config, c, logger);
    logger.info(
      { stage, residual_categories: Object.keys(c) },
      'verbatim-pii-scan re-returning residual_pii_detected hold from failed marker',
    );
    // Same detail shape as the extract handler's residual hold + the step-5 path above.
    return {
      action: 'hold',
      reason: 'residual_pii_detected',
      errorCode: 'VERBATIM_PII_DETECTED',
      detail: { residual_categories: Object.keys(c), counts: c },
    };
  }
  if (kind === 'tokened_phrase' || kind === 'verbatim_mismatch') {
    // The stored numeric metadata IS pii_scan_counts.
    return malformedHold(pool, callId, stage, config, logger, kind, counts ?? {});
  }
  // A `failed` row with a null kind is impossible under the DB `failed⇔kind` CHECK; masking it
  // as a plausible schema_invalid hold would contradict this handler's fail-loud philosophy.
  throw new Error(
    `verbatim-pii-scan: candidate for ${callId} is 'failed' but pii_scan_failure_kind is null — ` +
      `corrupt row, invariant break`,
  );
}

/**
 * Record a resilient deduped `MODEL_MALFORMED_RESPONSE` alert (an alert-insert failure never
 * blocks the hold) and return the `schema_invalid` hold. `metadata` is numeric-only.
 */
async function malformedHold(
  pool: StageContext['pool'],
  callId: string,
  stage: PipelineStage,
  config: Config,
  logger: StageContext['logger'],
  gate: PiiScanFailureKind,
  metadata: Record<string, number>,
): Promise<StageResult> {
  await resilientSideEffect(logger, callId, stage, `alert MODEL_MALFORMED_RESPONSE (${gate})`, () =>
    recordStageAlert(
      pool,
      callId,
      stage,
      config,
      'MODEL_MALFORMED_RESPONSE',
      'continuing',
      metadata,
    ),
  );
  logger.info(
    { stage, gate },
    'verbatim-pii-scan gate rejected persisted customer_language — holding schema_invalid',
  );
  const detail: Record<string, JsonValue> = { gate, ...metadata };
  return {
    action: 'hold',
    reason: 'schema_invalid',
    errorCode: 'MODEL_MALFORMED_RESPONSE',
    detail,
  };
}
