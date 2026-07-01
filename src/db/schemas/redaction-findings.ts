import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** redaction_findings — detected entities; token ref or hash, never raw value. Purgeable. */
export const redactionFindingRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string(),
  entity_type: z.string(),
  token_ref: z.string().nullable(),
  value_hash: z.instanceof(Buffer).nullable(),
  residual_scan_result: jsonValueSchema,
  created_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type RedactionFindingRow = z.infer<typeof redactionFindingRowSchema>;

export const redactionFindingInsertSchema = z.object({
  entityType: z.string().min(1),
  tokenRef: z.string().nullable().optional(),
  valueHash: z.instanceof(Buffer).nullable().optional(),
  residualScanResult: jsonValueSchema.optional(),
});
export type RedactionFindingInsert = z.infer<typeof redactionFindingInsertSchema>;
