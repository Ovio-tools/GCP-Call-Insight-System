import { z } from 'zod';
import { jsonValueSchema } from '../types.js';

/** clean_transcripts — redacted text + risk score. Purgeable. PK: call_id. */
export const cleanTranscriptRowSchema = z.object({
  call_id: z.string(),
  redacted_text: z.string(),
  // numeric(5,4): node-pg returns numeric as a string to preserve precision.
  redaction_risk_score: z.string(),
  redaction_reasons: jsonValueSchema,
  created_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type CleanTranscriptRow = z.infer<typeof cleanTranscriptRowSchema>;

export const cleanTranscriptInsertSchema = z.object({
  callId: z.string().min(1),
  redactedText: z.string(),
  // Risk in [0,1]; stored into numeric(5,4). Accept a number, pass as string on write.
  redactionRiskScore: z.number().min(0).max(1),
  redactionReasons: z.array(z.string()).optional(),
});
export type CleanTranscriptInsert = z.infer<typeof cleanTranscriptInsertSchema>;
