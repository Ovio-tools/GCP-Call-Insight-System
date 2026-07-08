import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { Config } from '../config/schema.js';
import { createBootLogger } from '../boot/logger.js';
import { createAppPool } from '../db/index.js';
import type { KeyProvider } from '../crypto/index.js';
import { getTranscript } from '../db/repositories/raw-transcripts-repo.js';
import { buildServiceKeyProvider } from '../key-lifecycle/readiness.js';
import { composeRedaction } from '../redaction/compose.js';
import { requireRedactionConfig } from '../redaction/config.js';
import { loadDenyList } from '../redaction/deny-list.js';
import { createDenyListDetector } from '../redaction/deny-list.js';
import { createNerDetector } from '../redaction/ner-detector.js';
import { createRegexDetector } from '../redaction/regex-detectors.js';
import { isVaultValueReintroduced } from '../redaction/residual-scan.js';
import { transcriptToRedactableText } from '../redaction/transcript-text.js';
import type { Detector } from '../redaction/types.js';
import { assertStagingResources } from '../sample-validation/index.js';

/**
 * OFFLINE REDACTION INSPECTION (operator diagnostic).
 *
 * For a bounded list of already-fetched call ids, decrypt the raw transcript, run the EXACT
 * redaction-stage input + detectors + tokenizer + independent residual scan, and print what the
 * residual gate is holding on — the redacted output, the values that were vaulted, and the
 * specific vaulted value(s) that reappear unredacted (with a small context window). This lets the
 * data controller manually verify that a `residual_pii_detected` hold is a GENUINE leak (a name
 * NER caught once but missed elsewhere, a number the primary layers missed) versus a false hold.
 *
 * IT PRINTS REAL TRANSCRIPT CONTENT to stdout. It is therefore hard-gated to the SAME §0.2
 * exception the sample-validation harness uses: staging-only, and no configured resource may
 * resolve to a production host (`assertStagingResources`, checked before ANY decrypt). It reads
 * only `raw_transcripts` (envelope-decrypted in-process) and never leaves Railway; it writes
 * NOTHING (no clean row, no vault, no findings, no model call). Run it as a one-off (e.g. a
 * temporary Railway start command); see `docs/redaction-inspection.md`.
 *
 * Usage:
 *   node dist/scripts/inspect-redaction.js --calls <id1,id2,...> [--full]
 *     --full   also print the entire extracted + redacted text (more content exposure)
 */

/** One value that reappeared in the redacted output, with context windows for the operator. */
export interface Reintroduction {
  value: string;
  contexts: readonly string[];
}

/** The PII-bearing inspection result for a single call. Formatted by {@link formatCallInspection}. */
export interface CallInspection {
  callId: string;
  /** False when no raw transcript row exists (nothing to inspect). */
  present: boolean;
  extractedLength?: number;
  detectionCount?: number;
  /** Plaintext values the detectors vaulted — i.e. what redaction DID catch. */
  vaultValues?: readonly string[];
  /** The redacted output the residual scan saw. */
  redactedText?: string;
  /** Residual categories → counts (PII-free), mirrors what the stage persists. */
  residualCounts?: Record<string, number>;
  /** Vaulted values that reappear unredacted in the output (the leak the scan holds on). */
  reintroduced?: readonly Reintroduction[];
}

/** Bounded, case-insensitive context windows around each literal occurrence of `value` in `text`. */
export function findContexts(value: string, text: string, radius = 48, cap = 5): string[] {
  if (value.length === 0) return [];
  const hay = text.toLowerCase();
  const needle = value.toLowerCase();
  const contexts: string[] = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    const start = Math.max(0, idx - radius);
    const end = Math.min(text.length, idx + value.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    contexts.push(`${prefix}${text.slice(start, end).replace(/\s+/g, ' ')}${suffix}`);
    from = idx + value.length;
    if (contexts.length >= cap) break;
  }
  return contexts;
}

/** Render a single call's inspection as human-readable text. Pure (no I/O) so it is unit-tested. */
export function formatCallInspection(c: CallInspection, opts: { full: boolean }): string {
  const lines: string[] = [];
  lines.push(`── call ${c.callId} ${'─'.repeat(Math.max(0, 48 - c.callId.length))}`);
  if (!c.present) {
    lines.push('  no raw transcript row (absent — nothing to inspect)');
    return lines.join('\n');
  }

  const counts = c.residualCounts ?? {};
  const categories = Object.keys(counts);
  lines.push(
    `  extracted chars: ${c.extractedLength ?? 0} | detections vaulted: ${c.detectionCount ?? 0}`,
  );
  if (categories.length === 0) {
    lines.push('  residual scan: no hits — this call would PASS redaction');
  } else {
    lines.push(`  residual scan: HOLD — ${categories.map((k) => `${k}=${counts[k]}`).join(', ')}`);
  }

  const reintros = c.reintroduced ?? [];
  if (reintros.length > 0) {
    lines.push('  reintroduced values (vaulted, but reappear unredacted in the output):');
    for (const r of reintros) {
      lines.push(`    • "${r.value}"`);
      for (const ctx of r.contexts) lines.push(`        ${ctx}`);
    }
  } else if ((counts.vault_value_reintroduced ?? 0) > 0) {
    lines.push('    (matched under normalization; see the full redacted text with --full)');
  }

  const vault = c.vaultValues ?? [];
  lines.push(`  vaulted values (${vault.length}): ${vault.map((v) => `"${v}"`).join(', ')}`);

  if (opts.full && c.redactedText !== undefined) {
    lines.push('  ── redacted text ──');
    lines.push(
      c.redactedText
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }
  return lines.join('\n');
}

export interface InspectDeps {
  detectors: readonly Detector[];
  denyTerms: readonly string[];
  keyProvider: KeyProvider;
}

/** Decrypt one call's raw transcript and run the exact redaction-stage pipeline (read-only). */
export async function inspectCall(
  pool: Pool,
  callId: string,
  deps: InspectDeps,
): Promise<CallInspection> {
  const raw = await getTranscript(pool, deps.keyProvider, callId);
  if (raw === undefined) return { callId, present: false };

  const transcript = transcriptToRedactableText(raw);
  const results = await Promise.all(deps.detectors.map((d) => d.detect(transcript)));
  const { tokenized, residual } = composeRedaction({
    text: transcript,
    detectorResults: results,
    denyTerms: deps.denyTerms,
  });
  const vaultValues = tokenized.vaultEntries.map((e) => e.plaintext);

  const reintroduced: Reintroduction[] = vaultValues
    .filter((v) => isVaultValueReintroduced(v, tokenized.redactedText))
    .map((value) => ({ value, contexts: findContexts(value, tokenized.redactedText) }));

  return {
    callId,
    present: true,
    extractedLength: transcript.length,
    detectionCount: tokenized.vaultEntries.length,
    vaultValues,
    redactedText: tokenized.redactedText,
    residualCounts: residual.counts,
    reintroduced,
  };
}

function parseArgs(argv: readonly string[]): { callIds: string[]; full: boolean } {
  const i = argv.indexOf('--calls');
  const calls = i >= 0 ? argv[i + 1] : undefined;
  if (calls === undefined) throw new Error('provide --calls <id1,id2,...>');
  const callIds = calls
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  if (callIds.length === 0) throw new Error('--calls must list at least one call id');
  return { callIds, full: argv.includes('--full') };
}

function buildDetectors(config: Config, denyTerms: readonly string[]): Detector[] {
  return [
    createNerDetector({
      modelId: config.REDACTION_NER_MODEL_ID,
      modelDir: config.REDACTION_NER_MODEL_DIR,
      minScore: config.REDACTION_NER_MIN_SCORE,
      chunkChars: config.REDACTION_NER_CHUNK_CHARS,
      chunkOverlapChars: config.REDACTION_NER_CHUNK_OVERLAP_CHARS,
      entityScope: new Set(config.REDACTION_NER_ENTITY_SCOPE),
    }),
    createRegexDetector(),
    createDenyListDetector(denyTerms),
  ];
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger: Logger = createBootLogger({ level: config.LOG_LEVEL, name: 'inspect-redaction' });
  requireRedactionConfig(config);

  // Same §0.2 gate as the sample-validation harness: staging-only + no production host. Refuse
  // BEFORE any DB connection or decrypt — this tool prints real content.
  assertStagingResources(config);
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const { callIds, full } = parseArgs(process.argv.slice(2));
  const denyTerms = loadDenyList(config.REDACTION_DENY_LIST_PATH);

  const pool = createAppPool(config.DATABASE_URL);
  try {
    const keyProvider = await buildServiceKeyProvider({ config, pool });
    const detectors = buildDetectors(config, denyTerms);
    const deps: InspectDeps = { detectors, denyTerms, keyProvider };

    process.stdout.write(
      `\n=== redaction inspection (staging, PII-exposing) — ${callIds.length} call(s) ===\n`,
    );
    for (const callId of callIds) {
      const inspection = await inspectCall(pool, callId, deps);
      process.stdout.write(`${formatCallInspection(inspection, { full })}\n\n`);
    }
    logger.info({ calls: callIds.length }, 'redaction inspection complete');
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`inspect-redaction failed: ${String(err)}\n`);
    process.exit(1);
  });
}
