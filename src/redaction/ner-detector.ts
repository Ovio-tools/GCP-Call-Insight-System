import { env, pipeline } from '@huggingface/transformers';
import type {
  Detection,
  Detector,
  DetectorResult,
  EntityType,
  NerEntityScope,
  RiskSignal,
} from './types.js';
import type { RiskReason } from './risk-reasons.js';

/**
 * Layer-1 NER detection (Task 4.1, precision-scoped by ADR 0006) — the ONLY
 * transformers.js touch-point in the codebase; its loose types are quarantined
 * behind the local interfaces below.
 *
 * Runs `Xenova/bert-base-NER` (quantized ONNX) fully in-process. The model is
 * vendored at build time by `npm run model:fetch`; at runtime
 * `env.allowRemoteModels = false` is the hard offline switch — a missing model
 * throws at load, the stage fails via retry/dead-letter, and nothing is ever
 * downloaded in the per-call path. Transcript text never leaves the process.
 *
 * Properties (step-0 spike 2026-07-01; precision rework ADR 0006):
 * - The token-classification pipeline returns `{entity, score, index, word}`
 *   with NO char offsets, so spans are reconstructed with a cursor-based
 *   wordpiece aligner. A failed alignment never guesses — it raises the
 *   forced-hold `ner_offset_alignment_failed` signal.
 * - Only candidate spans inside `entityScope` are redacted: PERSON by default,
 *   plus locations with an adjacent house number ({@link numberedLocationPrefix}).
 *   Bare LOC/ORG/MISC are a scope opt-in — on real trade calls they were almost
 *   entirely non-PII (rooms, fixtures, cities) and their vaulted surfaces
 *   re-triggered the residual scan, holding every call.
 * - Spans below `minScore` are DROPPED (not redacted) and raise
 *   `ner_low_confidence` — the deliberate fail-safe relaxation of ADR 0006; the
 *   regex layer, deny list, and residual scan remain independent backstops.
 * - The model is cased and misses all-lowercase names ("kevin oconnor": spike
 *   recall 22/24), so detection runs TWO passes — original text and a
 *   title-cased copy (identical length, offsets map 1:1) — spike recall 24/24.
 *   Title-case-pass spans count ONLY for PERSON: promoting common nouns
 *   ("bathroom" → "Bathroom") into LOC/ORG/MISC entities was the biggest
 *   over-redaction source. Across passes, duplicate spans keep the HIGHEST
 *   confidence, so a span confidently found in either pass survives the gate.
 */

export interface NerConfig {
  modelId: string;
  modelDir: string;
  /** Spans below this confidence are dropped and raise ner_low_confidence (ADR 0006). */
  minScore: number;
  chunkChars: number;
  chunkOverlapChars: number;
  /** Which NER detection types are redacted at all (ADR 0006). */
  entityScope: ReadonlySet<NerEntityScope>;
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

/** ADR 0006 numbered-LOC adjacency: "4482 Kensington Meadows" — 1-6 digits, not
 * the tail of a longer digit run, separated from the span start by horizontal
 * whitespace only. Anchoring on the SPAN START (not "a number within N chars")
 * is what keeps "we have 2 units in Roseville" from firing. */
const HOUSE_NUMBER_BEFORE = /(?<!\d)\d{1,6}[ \t]+$/;
/** 6 digits + generous horizontal whitespace. */
const HOUSE_NUMBER_WINDOW = 12;

/**
 * Does a house-style number immediately precede the location span at
 * `spanStart`? Returns the widened span start (covering the number, so it is
 * vaulted with the location and can never leak beside the token) or null.
 */
export function numberedLocationPrefix(text: string, spanStart: number): number | null {
  const windowStart = Math.max(0, spanStart - HOUSE_NUMBER_WINDOW);
  const m = HOUSE_NUMBER_BEFORE.exec(text.slice(windowStart, spanStart));
  return m ? windowStart + m.index : null;
}

interface AlignResult {
  spans: Detection[];
  alignmentFailed: boolean;
  truncated: boolean;
}

/** A char that belongs to the same spoken word: letters, digits, apostrophes,
 * hyphens — so snapped spans cover `D'Angelo`, `Gonzalez-Ruiz`, `Raley's` whole. */
const WORD_CHAR = /[A-Za-z0-9'’-]/;

/**
 * Cursor-based wordpiece → char-offset alignment. Walks EVERY token (including
 * `O`) to keep the cursor synchronized with the source text; emits spans for
 * contiguous `B-X`/`I-X` runs, SNAPPED outward to whole-word boundaries so a
 * partial-wordpiece run ("Bathroom Tu" of "Bathroom Turned") never yields a
 * fragment redaction that leaves the rest of the word behind. Snapping only
 * ever widens (fail-safe) and never moves the cursor. Per-span confidence is
 * the MEAN of the wordpiece scores — one weak `##` piece must not sink a real
 * multi-word name now that sub-minScore spans are dropped. Alignment failure
 * on an ENTITY token is fatal for trust in the output (`alignmentFailed`);
 * failure on an `O` token is benign.
 *
 * Exported for direct unit tests (`align-tokens.test.ts`); not part of the
 * module's public surface otherwise.
 */
export function alignTokens(
  text: string,
  tokens: readonly TokenHit[],
  offset: number,
): AlignResult {
  const spans: Detection[] = [];
  let alignmentFailed = false;
  let cursor = 0;
  let current: {
    start: number;
    end: number;
    entityType: EntityType;
    scoreSum: number;
    pieceCount: number;
  } | null = null;

  const flush = (): void => {
    if (current) {
      let { start, end } = current;
      while (start > 0 && WORD_CHAR.test(text[start - 1] ?? '')) start -= 1;
      while (end < text.length && WORD_CHAR.test(text[end] ?? '')) end += 1;
      spans.push({
        start: start + offset,
        end: end + offset,
        entityType: current.entityType,
        detector: 'ner',
        confidence: current.scoreSum / current.pieceCount,
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
      current.scoreSum += t.score;
      current.pieceCount += 1;
    } else {
      flush();
      current = { start, end, entityType, scoreSum: t.score, pieceCount: 1 };
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

      const candidates: Detection[] = [];
      const reasons = new Set<RiskReason>();

      for (const start of chunkStarts(text.length, cfg.chunkChars, cfg.chunkOverlapChars)) {
        const chunk = text.slice(start, start + cfg.chunkChars);
        // Dual pass: original + title-cased (identical length ⇒ same offsets).
        for (const [pass, variant] of [chunk, titleCase(chunk)].entries()) {
          const tokens = await pipe(variant, { ignore_labels: [] });
          const aligned = alignTokens(variant, tokens, start);
          // The title-cased pass exists solely for lowercase-NAME recall; its
          // LOC/ORG/MISC hits are common nouns promoted by the casing (ADR 0006).
          candidates.push(
            ...(pass === 0 ? aligned.spans : aligned.spans.filter((d) => d.entityType === 'name')),
          );
          if (aligned.alignmentFailed) reasons.add('ner_offset_alignment_failed');
          if (aligned.truncated) reasons.add('transcript_chunking_truncated');
        }
      }

      // Dedupe identical spans across passes/overlaps, keeping the HIGHEST
      // confidence: a span confidently found in EITHER pass is a real entity and
      // must survive the gate below (lowercase names score high only title-cased).
      const byKey = new Map<string, Detection>();
      for (const d of candidates) {
        const key = `${String(d.start)}:${String(d.end)}:${d.entityType}`;
        const existing = byKey.get(key);
        if (!existing || (d.confidence ?? 0) > (existing.confidence ?? 0)) {
          byKey.set(key, d);
        }
      }

      // Entity-scope policy filter (ADR 0006) — silent: an out-of-scope type is a
      // signed-off policy decision, not detection uncertainty, so no signal.
      const scoped: Detection[] = [];
      for (const d of byKey.values()) {
        switch (d.entityType) {
          case 'name':
            if (cfg.entityScope.has('person')) scoped.push(d);
            break;
          case 'location':
            if (cfg.entityScope.has('location')) {
              scoped.push(d);
            } else if (cfg.entityScope.has('numbered_location')) {
              // Widen over the house number so it is vaulted with the location
              // and a bare "4482" can never sit beside the [LOCATION_n] token.
              const widened = numberedLocationPrefix(text, d.start);
              if (widened !== null) scoped.push({ ...d, start: widened });
            }
            break;
          case 'organization':
            if (cfg.entityScope.has('organization')) scoped.push(d);
            break;
          default:
            if (cfg.entityScope.has('misc')) scoped.push(d);
        }
      }

      // Confidence gate (ADR 0006): sub-minScore spans are DROPPED. The signal
      // means a suspected-entity surface remains in the output un-redacted.
      const kept = scoped.filter((d) => (d.confidence ?? 1) >= cfg.minScore);
      if (kept.length < scoped.length) reasons.add('ner_low_confidence');

      const detections = kept.sort((a, b) => a.start - b.start || a.end - b.end);
      const riskSignals: RiskSignal[] = [...reasons].map((reason) => ({ reason }));
      return { detections, riskSignals };
    },
  };
}
