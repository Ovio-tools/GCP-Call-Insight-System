import { z } from 'zod';
import {
  callIntentSchema,
  sentimentSchema,
  serviceCategorySchema,
  urgencySchema,
} from '../enums.js';

/** structured_knowledge — the durable extracted record (execution plan 5.2). PK: call_id. */
export const structuredKnowledgeRowSchema = z.object({
  call_id: z.string(),
  call_intent: callIntentSchema,
  service_category: serviceCategorySchema,
  problem_statement: z.string().nullable(),
  symptoms: z.array(z.string()),
  customer_language: z.array(z.string()),
  location_in_home: z.string().nullable(),
  access_or_scheduling_notes: z.string().nullable(),
  prior_attempts: z.string().nullable(),
  urgency: urgencySchema,
  concerns: z.array(z.string()),
  // Internal-only (ADR: sentiment internal only); controlled vocabulary owned by 5.2.
  sentiment: sentimentSchema,
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
  serviceCategory: serviceCategorySchema,
  problemStatement: z.string().nullable().optional(),
  symptoms: z.array(z.string()).optional(),
  customerLanguage: z.array(z.string()).optional(),
  locationInHome: z.string().nullable().optional(),
  accessOrSchedulingNotes: z.string().nullable().optional(),
  priorAttempts: z.string().nullable().optional(),
  urgency: urgencySchema,
  concerns: z.array(z.string()).optional(),
  sentiment: sentimentSchema,
  acquisitionSource: z.string().nullable().optional(),
  competitorMentions: z.array(z.string()).optional(),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1),
  modelId: z.string().min(1),
});
export type StructuredKnowledgeInsert = z.infer<typeof structuredKnowledgeInsertSchema>;
