import { env, pipeline } from '@huggingface/transformers';
import type { Detection, Detector, DetectorResult, EntityType, RiskSignal } from './types.js';
import type { RiskReason } from './risk-reasons.js';

/**
 * Layer-1 NER detection (Task 4.1) — the ONLY transformers.js touch-point in the
 * codebase; its loose types are quarantined behind the local interfaces below.
 *
 * Runs `Xenova/bert-base-NER` (quantized ONNX) fully in-process. The model is
 * vendored at build time by `npm run model:fetch`; at runtime
 * `env.allowRemoteModels = false` is the hard offline switch — a missing model
 * throws at load, the stage fails via retry/dead-letter, and nothing is ever
 * downloaded in the per-call path. Transcript text never leaves the process.
 *
 * Fail-closed properties (step-0 spike, 2026-07-01):
 * - The token-classification pipeline returns `{entity, score, index, word}`
 *   with NO char offsets, so spans are reconstructed with a cursor-based
 *   wordpiece aligner. A failed alignment never guesses — it raises the
 *   forced-hold `ner_offset_alignment_failed` signal.
 * - EVERY candidate span is redacted regardless of confidence. `minScore` only
 *   decides whether `ner_low_confidence` is raised; it never drops a span.
 * - The model is cased and misses all-lowercase names ("kevin oconnor": spike
 *   recall 22/24), so detection runs TWO passes — original text and a
 *   title-cased copy (identical length, offsets map 1:1) — spike recall 24/24.
 *   Extra spans from the title-cased pass only over-redact, which is cheap.
 */

export interface NerConfig {
  modelId: string;
  modelDir: string;
  /** Spans below this confidence still get redacted but raise ner_low_confidence. */
  minScore: number;
  chunkChars: number;
  chunkOverlapChars: number;
}

/** Per-wordpiece output of the token-classification pipeline (spike-verified shape). */
interface TokenHit {
  entity: string;
  score: number;
  word: string;
}

type NerPipe = (text: string, opts: { ignore_labels: string[] }) => Promise<TokenHit[]>;

const LABEL_MAP: Record<string, EntityType> = {
  PER: 'name',
  LOC: 'location',
  ORG: 'organization',
  // MISC is redacted too — fail safe: better an extra token than a leaked detail.
  MISC: 'other',
};

/**
 * bert-base models cap at 512 wordpieces. The pipeline truncates silently, so a
 * chunk whose OUTPUT saturates near that cap was probably cut — part of the text
 * was never scanned, which must surface as transcript_chunking_truncated.
 */
const TRUNCATION_TOKEN_COUNT = 510;

/** One pipeline per (modelDir, modelId), loaded lazily on first detect(). */
const pipeCache = new Map<string, Promise<NerPipe>>();

function loadPipe(cfg: NerConfig): Promise<NerPipe> {
  const key = `${cfg.modelDir}::${cfg.modelId}`;
  let cached = pipeCache.get(key);
  if (!cached) {
    // Hard offline switch: the per-call path may only read the vendored model.
    env.allowRemoteModels = false;
    env.cacheDir = cfg.modelDir;
    env.localModelPath = cfg.modelDir;
    cached = pipeline('token-classification', cfg.modelId, { dtype: 'q8' }).then(
      (p) => p as unknown as NerPipe,
    );
    pipeCache.set(key, cached);
  }
  return cached;
}

/** Title-cases ASCII word starts (apostrophes don't start a new word: "it's",
 * "o'connor"). Same length as the input, so offsets map 1:1. */
export function titleCase(text: string): string {
  return text.replace(/(?<![A-Za-z'])[a-z]/g, (c) => c.toUpperCase());
}

interface AlignResult {
  spans: Detection[];
  alignmentFailed: boolean;
  truncated: boolean;
}

/**
 * Cursor-based wordpiece → char-offset alignment. Walks EVERY token (including
 * `O`) to keep the cursor synchronized with the source text; emits spans for
 * contiguous `B-X`/`I-X` runs. Alignment failure on an ENTITY token is fatal for
 * trust in the output (`alignmentFailed`); failure on an `O` token is benign.
 */
function alignTokens(text: string, tokens: readonly TokenHit[], offset: number): AlignResult {
  const spans: Detection[] = [];
  let alignmentFailed = false;
  let cursor = 0;
  let current: { start: number; end: number; entityType: EntityType; confidence: number } | null =
    null;

  const flush = (): void => {
    if (current) {
      spans.push({
        start: current.start + offset,
        end: current.end + offset,
        entityType: current.entityType,
        detector: 'ner',
        confidence: current.confidence,
      });
      current = null;
    }
  };

  for (const t of tokens) {
    const isEntity = t.entity !== 'O';
    const isContinuation = t.word.startsWith('##');
    const piece = isContinuation ? t.word.slice(2) : t.word;

    if (piece === '[UNK]' || piece.length === 0) {
      // Unalignable piece. Inside/adjacent to an entity: we can no longer trust
      // the surface we'd redact — fail closed.
      if (isEntity) alignmentFailed = true;
      flush();
      continue;
    }

    const at = text.toLowerCase().indexOf(piece.toLowerCase(), cursor);
    if (at === -1) {
      if (isEntity) alignmentFailed = true;
      flush();
      continue;
    }
    const start = at;
    const end = at + piece.length;
    cursor = end;

    if (!isEntity) {
      flush();
      continue;
    }

    const label = t.entity.split('-')[1];
    const entityType = LABEL_MAP[label ?? ''] ?? 'other';
    // Extend on contiguity + same type REGARDLESS of the B-/I- marker: the quantized
    // model labels continuation wordpieces inconsistently (B- on `##` pieces), and
    // strict B/I merging fragments multi-word entities into misaligned shards.
    // Over-merging two adjacent same-type entities only widens the redaction.
    const contiguous = current !== null && (isContinuation || start - current.end <= 1);
    if (current && current.entityType === entityType && contiguous) {
      current.end = end;
      current.confidence = Math.min(current.confidence, t.score);
    } else {
      flush();
      current = { start, end, entityType, confidence: t.score };
    }
  }
  flush();

  return { spans, alignmentFailed, truncated: tokens.length >= TRUNCATION_TOKEN_COUNT };
}

/** Split into overlapping chunks so boundary-spanning entities are seen whole. */
function chunkStarts(length: number, chunkChars: number, overlap: number): number[] {
  const step = Math.max(1, chunkChars - overlap);
  const starts: number[] = [];
  for (let s = 0; s === 0 || s < length; s += step) {
    starts.push(s);
    if (s + chunkChars >= length) break;
  }
  return starts;
}

export function createNerDetector(cfg: NerConfig): Detector {
  return {
    name: 'ner',
    async detect(text: string): Promise<DetectorResult> {
      const pipe = await loadPipe(cfg);

      const detections: Detection[] = [];
      const reasons = new Set<RiskReason>();

      for (const start of chunkStarts(text.length, cfg.chunkChars, cfg.chunkOverlapChars)) {
        const chunk = text.slice(start, start + cfg.chunkChars);
        // Dual pass: original + title-cased (identical length ⇒ same offsets).
        for (const variant of [chunk, titleCase(chunk)]) {
          const tokens = await pipe(variant, { ignore_labels: [] });
          const aligned = alignTokens(variant, tokens, start);
          detections.push(...aligned.spans);
          if (aligned.alignmentFailed) reasons.add('ner_offset_alignment_failed');
          if (aligned.truncated) reasons.add('transcript_chunking_truncated');
        }
      }

      // Dedupe identical spans across passes/overlaps, keeping the lowest confidence.
      const byKey = new Map<string, Detection>();
      for (const d of detections) {
        const key = `${String(d.start)}:${String(d.end)}:${d.entityType}`;
        const existing = byKey.get(key);
        if (!existing || (d.confidence ?? 1) < (existing.confidence ?? 1)) {
          byKey.set(key, d);
        }
      }
      const deduped = [...byKey.values()].sort((a, b) => a.start - b.start || a.end - b.end);

      if (deduped.some((d) => (d.confidence ?? 1) < cfg.minScore)) {
        reasons.add('ner_low_confidence');
      }

      const riskSignals: RiskSignal[] = [...reasons].map((reason) => ({ reason }));
      return { detections: deduped, riskSignals };
    },
  };
}
