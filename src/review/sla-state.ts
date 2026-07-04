import { REVIEW_SLA_SCAN_CADENCE_MINUTES } from '../config/schema.js';

/** The reviewer-facing SLA state of a held item, relative to a clock. */
export type SlaState = 'ok' | 'due_soon' | 'breached';

/** How long before `sla_due_at` an item reads `due_soon`: one breach-detection cadence, so an
 * item flips to `due_soon` no earlier than one scan before it would breach. */
const DUE_SOON_LEAD_MS = REVIEW_SLA_SCAN_CADENCE_MINUTES * 60_000;

/**
 * The SLA state of a held item (Task 6.2): `breached` once `now >= sla_due_at`, `due_soon` within
 * one scan cadence of the due time, else `ok`. A null `sla_due_at` (only possible on an already
 * closed row — the active-row CHECK forbids it) reads `ok`, since a closed item has no live SLA.
 */
export function slaState(slaDueAt: Date | null, now: Date): SlaState {
  if (slaDueAt === null) return 'ok';
  const due = slaDueAt.getTime();
  const t = now.getTime();
  if (t >= due) return 'breached';
  if (t >= due - DUE_SOON_LEAD_MS) return 'due_soon';
  return 'ok';
}
