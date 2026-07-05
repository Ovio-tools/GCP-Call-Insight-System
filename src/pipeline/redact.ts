import type { Pool } from 'pg';
import type { Config } from '../config/schema.js';
import type { KeyProvider } from '../crypto/index.js';
import { DAL_QUERY_FAILED, DalError } from '../db/errors.js';
import { createFailure, dedupKey, failureSnapshot } from '../failure-model/index.js';
import { recordAlert } from '../db/repositories/alert-events-repo.js';
import {
  hasHardDeletedCleanTranscript,
  softDeleteCleanTranscript,
  upsertCleanTranscript,
} from '../db/repositories/clean-transcripts-repo.js';
import { replaceFindings } from '../db/repositories/redaction-findings-repo.js';
import { getTranscript } from '../db/repositories/raw-transcripts-repo.js';
import { hasRawPurgedReview } from '../db/repositories/review-queue-repo.js';
import type { RedactionFindingInsert } from '../db/schemas/redaction-findings.js';
import {
  type RestrictedRunner,
  createRestrictedRunner,
} from '../db/restricted/restricted-context.js';
import { putToken } from '../db/restricted/token-vault-repo.js';
import { requireRedactionConfig } from '../redaction/config.js';
import { createDenyListDetector, loadDenyList } from '../redaction/deny-list.js';
import { createNerDetector } from '../redaction/ner-detector.js';
import { createRegexDetector } from '../redaction/regex-detectors.js';
import { residualScan } from '../redaction/residual-scan.js';
import { deriveSpanSignals, scoreRisk, shouldHoldForRisk } from '../redaction/risk.js';
import { mergeDetections } from '../redaction/spans.js';
import { tokenize } from '../redaction/tokenize.js';
import type { Detector, RiskSignal } from '../redaction/types.js';
import { valueHash } from '../redaction/value-hash.js';
import type { StageContext, StageHandler, StageResult } from './stages.js';

/**
 * The `redact` stage handler (Task 4.1) — the system privacy boundary. Reads the
 * raw transcript through the envelope-decryption path, runs layered detection
 * (NER + regex + deny-list), replaces every merged span with a stable per-call
 * token vaulted in token_vault, records findings (token refs + per-call value
 * hashes, never raw values), scores risk with explicit reasons, runs the
 * independent residual scan over the output, and decides: continue or hold.
 *
 * OUTPUT CONTRACT FOR MODEL STAGES (classify 5.1 / extract 5.2): downstream
 * stages read ONLY getCleanTranscript(pool, callId) — never raw_transcripts,
 * never token_vault (mechanically enforced by the model-stage import guard). A
 * clean row exists only for calls this stage passed or risk-held with every
 * reason safe_after_redaction; the runner's held-terminal guard means a held
 * call never advances, so its clean row can never be egressed.
 *
 * Persist order (each write idempotent; a crash anywhere + rerun is safe):
 * vault FIRST (no finding/clean row may reference an unvaulted token), then
 * findings (atomic replace, always including the call-level residual_scan row),
 * then the clean row — written only when the output text is believed safe,
 * soft-deleted otherwise (residual hits and unsafe risk holds must not leave
 * readable text in an unencrypted app_role table).
 */
export interface RedactionDeps {
  keyProvider: KeyProvider;
  config: Config;
  /** Test injection. Default: [NER, regex, deny-list] built from config. */
  detectors?: readonly Detector[];
  /** Test injection. Default: createRestrictedRunner. */
  makeRestrictedRunner?: (pool: Pool) => RestrictedRunner;
  /** Test injection. Default: loadDenyList(config.REDACTION_DENY_LIST_PATH). */
  denyTerms?: readonly string[];
}

type HoldReason = 'residual_pii_detected' | 'redaction_failed';

/**
 * Persist the deduped REDACTION_LOW_CONFIDENCE alert for a hold. holdCall (via the
 * runner) writes only call_state/review_queue/processing_log, so the stage must
 * alert itself — mirrors fetch-transcript's missing-transcript alert. The snapshot
 * carries counts/scores/reason codes only: no transcript text, values, spans, or
 * token refs.
 */
async function recordRedactionHoldAlert(
  pool: Pool,
  ctx: { callId: string; stage: string; environment: string },
  reason: HoldReason,
  safeDetail: { risk_score: number; reasons: string[]; residual_categories?: string[] },
): Promise<void> {
  const failure = createFailure('REDACTION_LOW_CONFIDENCE', {
    processingState: 'degraded',
    context: { call_id: ctx.callId, stage: ctx.stage, environment: ctx.environment },
  });
  await recordAlert(pool, {
    errorCode: failure.error_code,
    rootCauseCategory: failure.root_cause_category,
    severity: failure.severity,
    dedupKey: dedupKey(failure),
    failureSnapshot: {
      ...failureSnapshot(failure),
      call_id: ctx.callId,
      stage: ctx.stage,
      held_reason: reason,
      ...safeDetail,
    },
  });
}

export function createRedactionHandler(deps: RedactionDeps): StageHandler {
  // Fail fast at factory time (backfill/reprocessing code that skips worker.ts
  // still can't run redaction on a bad config — never a per-call retry loop).
  const { valueHashKey } = requireRedactionConfig(deps.config);
  const denyTerms = deps.denyTerms ?? loadDenyList(deps.config.REDACTION_DENY_LIST_PATH);
  const detectors: readonly Detector[] = deps.detectors ?? [
    createNerDetector({
      modelId: deps.config.REDACTION_NER_MODEL_ID,
      modelDir: deps.config.REDACTION_NER_MODEL_DIR,
      minScore: deps.config.REDACTION_NER_MIN_SCORE,
      chunkChars: deps.config.REDACTION_NER_CHUNK_CHARS,
      chunkOverlapChars: deps.config.REDACTION_NER_CHUNK_OVERLAP_CHARS,
    }),
    createRegexDetector(),
    createDenyListDetector(denyTerms),
  ];
  const makeRunner = deps.makeRestrictedRunner ?? createRestrictedRunner;

  return async (ctx: StageContext): Promise<StageResult> => {
    const { callId, stage, logger, pool } = ctx;

    // 0. Retention preflight (defense-in-depth): a call is retention-final if its clean
    //    transcript was HARD-deleted, OR its raw/vault were HELD-CAP purged (raw_purged_at set;
    //    the physical delete leaves no tombstone). Abort before writing ANYTHING — otherwise
    //    vault/findings rows would be partially rewritten before the writers' own guards threw.
    //    The writers (putTranscript/putToken/upsertCleanTranscript) each carry the same guard as
    //    the authoritative second layer; the held-cap case is also transitively caught (raw gone
    //    ⇒ getTranscript undefined ⇒ missing_transcript hold), but the explicit check keeps the
    //    signal clear and never attempts a decrypt for a purged call.
    if (
      (await hasHardDeletedCleanTranscript(pool, callId)) ||
      (await hasRawPurgedReview(pool, callId))
    ) {
      throw new DalError(
        DAL_QUERY_FAILED,
        `${DAL_QUERY_FAILED}: this call is retention-final (clean hard-deleted or raw held-cap purged); redaction may not repopulate it (retention conflict)`,
        { table: 'clean_transcripts', call_id: callId },
      );
    }

    // 1. Input: raw transcript only, via envelope decryption. Absent ⇒ fail closed.
    const transcript = await getTranscript(pool, deps.keyProvider, callId);
    if (transcript === undefined) {
      logger.info({ stage }, 'raw transcript absent at redact — holding');
      return {
        action: 'hold',
        reason: 'missing_transcript',
        errorCode: 'DIALPAD_TRANSCRIPT_MISSING',
      };
    }

    // 2. Detect. Infrastructure throws (model missing/corrupt) propagate to the
    //    runner → BullMQ retry → dead-letter; the call never advances. Quality
    //    problems are not throws — they flow into risk signals below.
    const results = await Promise.all(detectors.map((d) => d.detect(transcript)));
    const detectorSignals: RiskSignal[] = results.flatMap((r) => [...r.riskSignals]);

    // 3. Merge → tokenize → residual → score (all in memory, before any write).
    const { spans, disagreement } = mergeDetections(results.flatMap((r) => [...r.detections]));
    const tokenized = tokenize(transcript, spans);
    const residual = residualScan({
      redactedText: tokenized.redactedText,
      vaultPlaintexts: tokenized.vaultEntries.map((e) => e.plaintext),
      denyTerms,
    });
    const residualHit = residual.hits.length > 0;

    const signals: RiskSignal[] = [
      ...detectorSignals,
      ...deriveSpanSignals({
        text: transcript,
        spans,
        disagreement,
        nerMinScore: deps.config.REDACTION_NER_MIN_SCORE,
      }),
      ...(residualHit ? [{ reason: 'residual_scan_hit' as const }] : []),
    ];
    const risk = scoreRisk(signals);
    const holdForRisk = shouldHoldForRisk(risk, deps.config.REDACTION_RISK_THRESHOLD);

    // 4a. Vault first: no finding/clean row may ever reference an unvaulted token.
    //     Stale rows from a prior detector version are harmless (highest-security
    //     table, purged with raw).
    const runner = makeRunner(pool);
    for (const entry of tokenized.vaultEntries) {
      await putToken(runner, deps.keyProvider, {
        callId,
        token: entry.token,
        plaintext: Buffer.from(entry.plaintext, 'utf8'),
      });
    }

    // 4b. Findings: per-token rows plus the ALWAYS-present call-level residual_scan
    //     row, so a residual-only hit still leaves an auditable record.
    const findingRows: RedactionFindingInsert[] = [
      ...tokenized.findings.map((f) => ({
        entityType: f.entityType,
        tokenRef: f.tokenRef,
        valueHash: valueHash(valueHashKey, callId, f.normalizedValue),
      })),
      {
        entityType: 'residual_scan',
        tokenRef: null,
        valueHash: null,
        residualScanResult: {
          categories: Object.keys(residual.counts),
          counts: residual.counts,
        },
      },
    ];
    await replaceFindings(pool, callId, findingRows);

    // 4c. Clean row: only when the output text is believed safe. A residual hit or
    //     any unsafe risk reason means the text may still contain PII — soft-delete
    //     instead (covers pass-then-rerun staleness too).
    const writeCleanRow = !residualHit && (!holdForRisk || risk.outputSafe);
    if (writeCleanRow) {
      await upsertCleanTranscript(pool, {
        callId,
        redactedText: tokenized.redactedText,
        redactionRiskScore: risk.score,
        redactionReasons: risk.reasons,
      });
    } else {
      await softDeleteCleanTranscript(pool, callId);
    }

    // 5. Decide. Detail/log payloads carry counts, scores, and reason codes only —
    //    key names deliberately avoid the logging guard's CONTENT_FIELDS.
    const env = deps.config.NODE_ENV;
    if (residualHit) {
      const residualCategories = Object.keys(residual.counts);
      await recordRedactionHoldAlert(
        pool,
        { callId, stage, environment: env },
        'residual_pii_detected',
        {
          risk_score: risk.score,
          reasons: risk.reasons,
          residual_categories: residualCategories,
        },
      );
      logger.info(
        { stage, risk_score: risk.score, residual_categories: residualCategories },
        'residual scan hit — holding residual_pii_detected',
      );
      return {
        action: 'hold',
        reason: 'residual_pii_detected',
        errorCode: 'REDACTION_LOW_CONFIDENCE',
        detail: {
          risk_score: risk.score,
          reasons: risk.reasons,
          residual_categories: residualCategories,
          finding_count: tokenized.findings.length,
        },
      };
    }

    if (holdForRisk) {
      await recordRedactionHoldAlert(
        pool,
        { callId, stage, environment: env },
        'redaction_failed',
        {
          risk_score: risk.score,
          reasons: risk.reasons,
        },
      );
      logger.info(
        { stage, risk_score: risk.score, reasons: risk.reasons, output_safe: risk.outputSafe },
        'risk threshold reached — holding redaction_failed',
      );
      return {
        action: 'hold',
        reason: 'redaction_failed',
        errorCode: 'REDACTION_LOW_CONFIDENCE',
        detail: {
          risk_score: risk.score,
          reasons: risk.reasons,
          finding_count: tokenized.findings.length,
          output_safe: risk.outputSafe,
        },
      };
    }

    logger.info(
      { stage, finding_count: tokenized.findings.length, risk_score: risk.score },
      'transcript redacted',
    );
    return { action: 'continue' };
  };
}
