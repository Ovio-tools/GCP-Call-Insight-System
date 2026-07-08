import {
  findAddressWindowDigits,
  findDenyTermOccurrences,
  findEmailLike,
  findGreetingNames,
  findLongDigitRuns,
  findSpelledDigitRuns,
  findVaultOccurrences,
  type MirrorSpan,
} from './mirror-finders.js';
import { isVaultValueReintroduced } from './residual-scan.js';
import { mergeDetections } from './spans.js';
import { tokenize, type TokenizedResult } from './tokenize.js';
import type { Detection, EntityType } from './types.js';

/**
 * The residual-mirror repair fixpoint (ADR 0007) — what makes the primary
 * layers a strict superset of the residual scan.
 *
 * Detectors over the ORIGINAL text cannot dominate the residual scan on their
 * own: the residual scans the OUTPUT, where token-stripping ([NAME_1] → ' ')
 * concatenates content across redacted spans — "123456 Bob 654321" has no
 * 7-digit run until Bob is redacted. So after merge+tokenize, this loop
 * rebuilds the residual's view (the EFFECTIVE text: original with covered
 * spans blanked to a single space — exactly equal to the output with tokens
 * stripped), re-runs every mirrored finder over it, maps hits back to
 * original-text spans, re-merges, re-tokenizes, and iterates.
 *
 * Precision neutrality: every finder mirrors a residual sub-scan, so anything
 * the loop redacts is something the residual would otherwise HOLD the call
 * for — it converts holds into redactions and never touches a call that
 * passes today.
 *
 * Exit requires BOTH no new finder hits AND the residual's own exported
 * `isVaultValueReintroduced` predicate clean for every vault entry — the
 * authoritative post-condition, imported (not mirrored) from the unchanged
 * residual module. Termination: every firing iteration strictly grows covered
 * chars (fully-covered hits are dropped), bounded by text length; the
 * iteration cap is a backstop, and a cap-hit simply returns converged:false —
 * the unchanged residual scan then holds the call (fail closed).
 */

export interface RepairInput {
  text: string;
  /** The merged detector spans (mergeDetections output). */
  spans: readonly Detection[];
  denyTerms: readonly string[];
  /** Backstop only — the loop terminates by coverage monotonicity. */
  maxIterations?: number;
}

export interface RepairResult {
  /** The final span set the output was tokenized with. */
  spans: readonly Detection[];
  /** tokenize() over the final span set — the stage's output. */
  tokenized: TokenizedResult;
  /** True when repair spans overlapped existing spans of another type. */
  disagreement: boolean;
  converged: boolean;
  iterations: number;
}

const REPAIR_MAX_ITERATIONS = 10;

/** Original text with every covered span replaced by ONE space — the residual's
 * token-stripped view of the output, with an offset map back (−1 = inserted). */
interface EffectiveText {
  text: string;
  map: number[];
}

function effectiveText(text: string, spans: readonly Detection[]): EffectiveText {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  const map: number[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // merged spans never overlap; guard anyway
    for (let i = pos; i < s.start; i += 1) {
      out.push(text[i] as string);
      map.push(i);
    }
    out.push(' ');
    map.push(-1);
    pos = s.end;
  }
  for (let i = pos; i < text.length; i += 1) {
    out.push(text[i] as string);
    map.push(i);
  }
  return { text: out.join(''), map };
}

/** Map an effective-text hit back to original offsets (trimming inserted blanks). */
function toOriginal(eff: EffectiveText, span: MirrorSpan): MirrorSpan | undefined {
  let start = -1;
  let end = -1;
  for (let i = span.start; i < span.end; i += 1) {
    const orig = eff.map[i] as number;
    if (orig >= 0) {
      start = orig;
      break;
    }
  }
  for (let i = span.end - 1; i >= span.start; i -= 1) {
    const orig = eff.map[i] as number;
    if (orig >= 0) {
      end = orig + 1;
      break;
    }
  }
  if (start < 0 || end <= start) return undefined;
  return { start, end };
}

export function repairToResidualClean(input: RepairInput): RepairResult {
  const maxIterations = input.maxIterations ?? REPAIR_MAX_ITERATIONS;
  let spans = input.spans;
  let disagreement = false;
  let tokenized = tokenize(input.text, spans);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const eff = effectiveText(input.text, spans);

    // Entity type per vaulted surface, so a propagated occurrence coalesces to
    // the SAME per-call token (tokenize keys on entityType + normalized surface).
    const typeByToken = new Map<string, EntityType>(
      tokenized.findings.map((f) => [f.tokenRef, f.entityType]),
    );

    const candidates: {
      span: MirrorSpan;
      entityType: EntityType;
      detector: Detection['detector'];
    }[] = [
      ...findLongDigitRuns(eff.text).map((span) => ({
        span,
        entityType: 'number' as const,
        detector: 'regex' as const,
      })),
      ...findSpelledDigitRuns(eff.text).map((span) => ({
        span,
        entityType: 'phone' as const,
        detector: 'regex' as const,
      })),
      ...findGreetingNames(eff.text).map((span) => ({
        span,
        entityType: 'name' as const,
        detector: 'regex' as const,
      })),
      ...findEmailLike(eff.text).map((span) => ({
        span,
        entityType: 'email' as const,
        detector: 'regex' as const,
      })),
      ...findAddressWindowDigits(eff.text).map((span) => ({
        span,
        entityType: 'number' as const,
        detector: 'regex' as const,
      })),
      ...findDenyTermOccurrences(eff.text, input.denyTerms).map((span) => ({
        span,
        entityType: 'deny_list' as const,
        detector: 'deny_list' as const,
      })),
      ...tokenized.vaultEntries.flatMap((entry) =>
        findVaultOccurrences(eff.text, entry.plaintext).map((span) => ({
          span,
          entityType: typeByToken.get(entry.token) ?? ('other' as const),
          detector: 'regex' as const,
        })),
      ),
    ];

    const additions: Detection[] = [];
    for (const c of candidates) {
      const orig = toOriginal(eff, c.span);
      if (!orig) continue;
      const covered = spans.some((s) => s.start <= orig.start && orig.end <= s.end);
      if (covered) continue;
      additions.push({ ...orig, entityType: c.entityType, detector: c.detector });
    }

    if (additions.length === 0) {
      const clean = tokenized.vaultEntries.every(
        (e) => !isVaultValueReintroduced(e.plaintext, tokenized.redactedText),
      );
      return { spans, tokenized, disagreement, converged: clean, iterations: iteration };
    }

    const merged = mergeDetections([...spans, ...additions]);
    spans = merged.spans;
    disagreement = disagreement || merged.disagreement;
    tokenized = tokenize(input.text, spans);
  }

  return { spans, tokenized, disagreement, converged: false, iterations: maxIterations };
}
