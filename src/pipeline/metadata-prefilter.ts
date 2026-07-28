import { z } from 'zod';
import type { DropReason } from '../db/enums.js';
import { getCallState } from '../db/repositories/call-state-repo.js';
import type { StageContext, StageHandler, StageResult } from './stages.js';

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

/** Tunable policy inputs. Kept separate from the metadata so the rules above stay pure
 *  facts-about-the-call and this stays the one knob an operator can turn. */
export interface PrefilterPolicy {
  /**
   * Minimum call duration (ms) that can plausibly hold a conversation; a call at or below it
   * drops as `below_minimum_duration`. `0` (the default) disables the rule entirely, which is
   * why every caller that has no config still behaves exactly as it did before this existed.
   */
  minDurationMs?: number;
}

/**
 * Decide whether a call passes the metadata pre-filter. `callId` is passed explicitly so
 * the operator-leg comparison never depends on a metadata field. Fails open: anything
 * unparseable, missing, or unclear → pass. First matching rule wins.
 */
export function evaluateMetadata(
  callId: string,
  metadata: unknown,
  policy: PrefilterPolicy = {},
): PrefilterOutcome {
  const parsed = callMetadataSchema.safeParse(metadata);
  if (!parsed.success) return { action: 'pass' };
  const m = parsed.data;

  // 1. Zero (or negative) duration — no call happened.
  if (typeof m.duration === 'number' && m.duration <= 0) return drop('zero_duration');

  // 2. A call state that clearly means no two-party conversation (any direction).
  if (typeof m.state === 'string' && NON_CONVERSATION_STATES.has(m.state.toLowerCase())) {
    return drop('non_conversation_call_state');
  }

  // 2b. Too short to hold a conversation. Deliberately ordered AFTER the two rules above:
  // those are FACTS Dialpad reported about the call ("never connected", "nobody answered"),
  // whereas this is a tunable JUDGEMENT, and the factual reason tells an operator more. A
  // sub-threshold call produces no transcript, so letting it through only manufactures an
  // unactionable `missing_transcript` hold for a person who can do nothing about it.
  const minDurationMs = policy.minDurationMs ?? 0;
  if (minDurationMs > 0 && typeof m.duration === 'number' && m.duration <= minDurationMs) {
    return drop('below_minimum_duration');
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

/**
 * Build the `metadata-pre-filter` stage handler under a given policy: reads the call's
 * `source_metadata`, evaluates it, and returns `drop` (→ the runner calls `skipCall`) or
 * `continue`. Logs only the stage and the controlled drop reason — never metadata values
 * or PII.
 */
export function createMetadataPreFilterHandler(policy: PrefilterPolicy): StageHandler {
  return async (ctx: StageContext): Promise<StageResult> => {
    const state = await getCallState(ctx.pool, ctx.callId);
    if (!state) {
      // The runner guarantees the row exists before invoking a handler; a vanished row is
      // a real inconsistency, not something to skip past silently.
      throw new Error(`call_state row for ${ctx.callId} vanished before metadata pre-filter`);
    }

    const outcome = evaluateMetadata(ctx.callId, state.source_metadata, policy);
    if (outcome.action === 'drop') {
      ctx.logger.info(
        { stage: ctx.stage, drop_reason: outcome.reason },
        'metadata pre-filter: drop',
      );
      return { action: 'drop', reason: outcome.reason };
    }

    ctx.logger.info({ stage: ctx.stage }, 'metadata pre-filter: pass');
    return { action: 'continue' };
  };
}

/**
 * The policy-free pre-filter handler: every rule that keys on a reported FACT, with the
 * tunable minimum-duration rule disabled. Used by dependency-free handler sets (and the
 * tests built on them) that have no `Config` to thread. Production wires
 * {@link createMetadataPreFilterHandler} with `PREFILTER_MIN_DURATION_MS` instead.
 */
export const metadataPreFilterHandler: StageHandler = createMetadataPreFilterHandler({});
