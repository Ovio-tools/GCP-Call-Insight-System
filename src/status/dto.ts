import { z } from 'zod';
import { severitySchema } from '../db/enums.js';

/**
 * The single, low-sensitivity status data contract (Task 7.3, plan §2). Every field is a
 * label, state, count, timestamp, budget number, error code, runbook ref, or sanitized
 * summary string — NOTHING else can be constructed (the allowlist serializer, plan §4,
 * re-validates against this schema before the DTO leaves the process).
 *
 * `null` vs `0` is explicit: any numeric metric the system does not KNOW is `null` (rendered
 * `unknown`); `0` appears only when the query succeeded and truly returned zero.
 */

/** A node's rendered health. `unknown` is a first-class, clearly-labelled state (a missing
 * signal reads as "unknown", never a blank or a broken page). */
export const NODE_STATES = ['healthy', 'idle', 'degraded', 'broken', 'paused', 'unknown'] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

/** The one-line summary pipeline state. */
export const PIPELINE_STATES = ['running', 'degraded', 'broken', 'paused', 'unknown'] as const;
export const pipelineStateSchema = z.enum(PIPELINE_STATES);
export type PipelineState = z.infer<typeof pipelineStateSchema>;

/** A fixed pipeline stage node. `count === null` → query failed → render `unknown`. */
export const stageNodeSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: nodeStateSchema,
  count: z.number().int().nonnegative().nullable(),
});
export type StageNode = z.infer<typeof stageNodeSchema>;

/** A fixed component node. `last_run_at` is an ISO string or null (no signal). */
export const componentNodeSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: nodeStateSchema,
  last_run_at: z.string().datetime().nullable(),
  count: z.number().int().nonnegative().nullable().optional(),
});
export type ComponentNode = z.infer<typeof componentNodeSchema>;

/** One held-for-review reason count, surfaced in the JSON breakdown. */
export const heldReasonCountSchema = z.object({
  held_reason: z.string(),
  count: z.number().int().nonnegative(),
});
export type HeldReasonCount = z.infer<typeof heldReasonCountSchema>;

export const spendSchema = z.object({
  spent_usd: z.number().nonnegative().nullable(),
  budget_usd: z.number().nonnegative(),
  /** `null` when the pause state cannot be determined — rendered `unknown`, never `false`. */
  model_paused: z.boolean().nullable(),
});
export type Spend = z.infer<typeof spendSchema>;

/** From the newest active `alert_events` row; text is catalog/`renderAlertText`-sourced
 * (PII-incapable). */
export const latestIssueSchema = z.object({
  error_code: z.string(),
  root_cause_category: z.string(),
  severity: severitySchema,
  summary: z.string(),
  runbook_ref: z.string(),
  at: z.string().datetime(),
});
export type LatestIssue = z.infer<typeof latestIssueSchema>;

export const componentsLastRunSchema = z.object({
  component: z.string(),
  last_run_at: z.string().datetime().nullable(),
  state: nodeStateSchema,
});

export const statusSummarySchema = z.object({
  pipeline_state: pipelineStateSchema,
  calls_processed_today: z.number().int().nonnegative().nullable(),
  calls_held_for_review: z.number().int().nonnegative().nullable(),
  /** Per-reason breakdown of held calls; `null` when the query failed. */
  held_by_reason: z.array(heldReasonCountSchema).nullable(),
  dead_letter_count: z.number().int().nonnegative().nullable(),
  spend: spendSchema,
  components_last_run: z.array(componentsLastRunSchema),
  latest_issue: latestIssueSchema.nullable(),
});
export type StatusSummary = z.infer<typeof statusSummarySchema>;

export const statusDtoSchema = z.object({
  generated_at: z.string().datetime(),
  summary: statusSummarySchema,
  pipeline_nodes: z.array(stageNodeSchema),
  components: z.array(componentNodeSchema),
});
export type StatusDTO = z.infer<typeof statusDtoSchema>;
