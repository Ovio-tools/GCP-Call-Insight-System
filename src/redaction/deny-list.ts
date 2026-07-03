import { readFileSync } from 'node:fs';
import { CONFIG_ERROR_CODE, ConfigError } from '../config/index.js';
import type { Detection, Detector, DetectorResult } from './types.js';

/**
 * Layer-3 deny-list detection (Task 4.1): client-specific terms that must never
 * pass redaction, loaded from a file OUTSIDE the repo (REDACTION_DENY_LIST_PATH).
 *
 * Matching runs over a normalized shadow of the text (lowercase, punctuation
 * runs collapsed to a single space) with an offset map back to the original, so
 * "Acme Plumbing", "acme  plumbing", and "ACME-PLUMBING" all hit and the reported
 * span covers the original surface. The normalizer here is PRIVATE to this layer —
 * the residual scanner keeps its own, stricter copy on purpose (independence).
 */

/**
 * Load deny-list terms: newline-delimited, `#` comments, blanks skipped.
 * `undefined` (unset config) means an empty deny list; a set-but-unreadable path
 * fails loudly with the config convention (never silently redact without the
 * client's mandatory terms).
 */
export function loadDenyList(path: string | undefined): string[] {
  if (path === undefined) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      ['REDACTION_DENY_LIST_PATH'],
      `${CONFIG_ERROR_CODE}: REDACTION_DENY_LIST_PATH is set but not readable`,
    );
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

interface NormalizedText {
  /** Lowercased text with every non-alphanumeric run collapsed to one space. */
  normalized: string;
  /** For each normalized char, the offset of its source char in the original. */
  map: number[];
}

function normalizeForMatch(text: string): NormalizedText {
  let normalized = '';
  const map: number[] = [];
  let pendingSeparatorAt = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (/[a-z0-9]/i.test(ch)) {
      if (pendingSeparatorAt >= 0 && normalized.length > 0) {
        normalized += ' ';
        map.push(pendingSeparatorAt);
      }
      pendingSeparatorAt = -1;
      normalized += ch.toLowerCase();
      map.push(i);
    } else if (pendingSeparatorAt < 0) {
      pendingSeparatorAt = i;
    }
  }
  return { normalized, map };
}

export function createDenyListDetector(terms: readonly string[]): Detector {
  const normalizedTerms = terms
    .map((t) => normalizeForMatch(t).normalized)
    .filter((t) => t.length > 0);

  return {
    name: 'deny_list',
    detect(text: string): Promise<DetectorResult> {
      const detections: Detection[] = [];
      if (normalizedTerms.length > 0) {
        const { normalized, map } = normalizeForMatch(text);
        for (const term of normalizedTerms) {
          let from = 0;
          for (;;) {
            const at = normalized.indexOf(term, from);
            if (at === -1) break;
            // Whole-word: the char before/after the hit must not be alphanumeric.
            const beforeOk = at === 0 || normalized[at - 1] === ' ';
            const afterOk =
              at + term.length === normalized.length || normalized[at + term.length] === ' ';
            if (beforeOk && afterOk) {
              const start = map[at]!;
              const end = map[at + term.length - 1]! + 1;
              detections.push({ start, end, entityType: 'deny_list', detector: 'deny_list' });
            }
            from = at + term.length;
          }
        }
      }
      detections.sort((a, b) => a.start - b.start);
      return Promise.resolve({ detections, riskSignals: [] });
    },
  };
}
