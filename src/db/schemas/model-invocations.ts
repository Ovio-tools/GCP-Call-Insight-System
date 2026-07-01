import { z } from 'zod';

/** model_invocations — per model call: model ID, prompt version, token counts. PK: id. */
export const modelInvocationRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string(),
  stage: z.string(),
  model_id: z.string(),
  prompt_version: z.string(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  outcome: z.string(),
  created_at: z.date(),
});
export type ModelInvocationRow = z.infer<typeof modelInvocationRowSchema>;

export const recordModelInvocationInputSchema = z.object({
  callId: z.string().min(1),
  stage: z.string().min(1),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  outcome: z.string().min(1),
});
export type RecordModelInvocationInput = z.infer<typeof recordModelInvocationInputSchema>;
