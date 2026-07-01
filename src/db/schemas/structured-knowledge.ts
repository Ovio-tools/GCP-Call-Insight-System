import { z } from 'zod';
import { callIntentSchema, urgencySchema } from '../enums.js';

/** structured_knowledge — the durable extracted record (execution plan 5.2). PK: call_id. */
export const structuredKnowledgeRowSchema = z.object({
  call_id: z.string(),
  call_intent: callIntentSchema,
  service_category: z.string(),
  problem_statement: z.string().nullable(),
  symptoms: z.array(z.string()),
  customer_language: z.array(z.string()),
  location_in_home: z.string().nullable(),
  access_or_scheduling_notes: z.string().nullable(),
  prior_attempts: z.string().nullable(),
  urgency: urgencySchema,
  concerns: z.array(z.string()),
  // Internal-only; controlled-value set finalized in Task 5.2. Text now.
  sentiment: z.string(),
  acquisition_source: z.string().nullable(),
  competitor_mentions: z.array(z.string()),
  schema_version: z.number().int(),
  prompt_version: z.string(),
  model_id: z.string(),
  created_at: z.date(),
});
export type StructuredKnowledgeRow = z.infer<typeof structuredKnowledgeRowSchema>;

export const structuredKnowledgeInsertSchema = z.object({
  callId: z.string().min(1),
  callIntent: callIntentSchema,
  serviceCategory: z.string().min(1),
  problemStatement: z.string().nullable().optional(),
  symptoms: z.array(z.string()).optional(),
  customerLanguage: z.array(z.string()).optional(),
  locationInHome: z.string().nullable().optional(),
  accessOrSchedulingNotes: z.string().nullable().optional(),
  priorAttempts: z.string().nullable().optional(),
  urgency: urgencySchema,
  concerns: z.array(z.string()).optional(),
  sentiment: z.string().min(1),
  acquisitionSource: z.string().nullable().optional(),
  competitorMentions: z.array(z.string()).optional(),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
});
export type StructuredKnowledgeInsert = z.infer<typeof structuredKnowledgeInsertSchema>;
