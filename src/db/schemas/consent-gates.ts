import { z } from 'zod';

/** consent_gates — recorded consents + legal gates. PK: id. gate_type is text (spec-TBD). */
export const consentGateRowSchema = z.object({
  id: z.string().uuid(),
  gate_type: z.string(),
  recorded_by: z.string(),
  evidence_ref: z.string().nullable(),
  recorded_at: z.date(),
});
export type ConsentGateRow = z.infer<typeof consentGateRowSchema>;

export const consentGateInsertSchema = z.object({
  gateType: z.string().min(1),
  recordedBy: z.string().min(1),
  evidenceRef: z.string().nullable().optional(),
});
export type ConsentGateInsert = z.infer<typeof consentGateInsertSchema>;
