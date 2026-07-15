import type { TranscriptResult } from '../dialpad/client/index.js';

export type DedupDecision =
  | { action: 'keep' }
  | { action: 'unresolved'; why: 'transcript_unavailable' | 'no_canonical_id' }
  | { action: 'canonical_missing'; canonicalCallId: string }
  | { action: 'supersede'; canonicalCallId: string };

/**
 * Decide what to do with one existing structured_knowledge row, given its transcript fetch and
 * whether the canonical row exists. Pure — no IO, no PII (ids only).
 */
export function classifyDedupRow(
  callId: string,
  fetch: TranscriptResult,
  canonicalRowExists: boolean,
): DedupDecision {
  if (fetch.kind !== 'ready') return { action: 'unresolved', why: 'transcript_unavailable' };
  const canonical = fetch.canonicalCallId;
  if (canonical === undefined) return { action: 'unresolved', why: 'no_canonical_id' };
  if (canonical === callId) return { action: 'keep' };
  if (!canonicalRowExists) return { action: 'canonical_missing', canonicalCallId: canonical };
  return { action: 'supersede', canonicalCallId: canonical };
}
