import { z } from 'zod';
import type { DropReason } from '../db/enums.js';

/**
 * Metadata pre-filter (Task 3.1) — a deterministic, metadata-only decision. Reads ONLY
 * the fields below off `call_state.source_metadata`. It NEVER reads transcript text,
 * calls a model, or logs PII. Every drop rule keys on an explicit positive marker, so a
 * wrong/unconfirmed field mapping can only under-drop (safe), never mis-drop a real call.
 *
 * Field names are provisional until Task 3.2 confirms the real Dialpad payload; the
 * lenient schema below is the single place to adjust them.
 */
const callMetadataSchema = z
  .object({
    duration: z.number().optional(),
    state: z.string().optional(),
    direction: z.string().optional(),
    operator_call_id: z.string().optional(),
    master_call_id: z.string().optional(),
    is_internal: z.boolean().optional(),
  })
  .passthrough();

/** Call states that unambiguously mean no two-party conversation happened. Lowercased. */
const NON_CONVERSATION_STATES: ReadonlySet<string> = new Set([
  'missed',
  'no_answer',
  'failed',
  'busy',
  'canceled',
  'abandoned',
  'rejected',
]);

export type PrefilterOutcome = { action: 'pass' } | { action: 'drop'; reason: DropReason };

const drop = (reason: DropReason): PrefilterOutcome => ({ action: 'drop', reason });

/**
 * Decide whether a call passes the metadata pre-filter. `callId` is passed explicitly so
 * the operator-leg comparison never depends on a metadata field. Fails open: anything
 * unparseable, missing, or unclear → pass. First matching rule wins.
 */
export function evaluateMetadata(callId: string, metadata: unknown): PrefilterOutcome {
  const parsed = callMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { action: 'pass' };
  const m = parsed.data;

  // 1. Zero (or negative) duration — no call happened.
  if (typeof m.duration === 'number' && m.duration <= 0) return drop('zero_duration');

  // 2. A call state that clearly means no two-party conversation (any direction).
  if (typeof m.state === 'string' && NON_CONVERSATION_STATES.has(m.state.toLowerCase())) {
    return drop('non_conversation_call_state');
  }

  // 3 & 4 require an EXPLICIT internal-leg marker. Without it, fail open.
  if (m.is_internal === true) {
    // 3. A flagged internal leg that the graph shows is not the operator/customer leg.
    if (typeof m.operator_call_id === 'string' && m.operator_call_id !== callId) {
      return drop('internal_transfer_non_operator_leg');
    }
    // 4. An explicitly internal outbound leg — operator-side dial-out, no customer.
    if (typeof m.direction === 'string' && m.direction.toLowerCase() === 'outbound') {
      return drop('outbound_no_customer_conversation');
    }
  }

  return { action: 'pass' };
}
