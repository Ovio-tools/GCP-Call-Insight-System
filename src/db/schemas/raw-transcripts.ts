import { z } from 'zod';

/** raw_transcripts — original transcript, envelope-encrypted. app_role table (encrypted,
 * but not restricted-role-only). Purgeable. PK: call_id. */
export const rawTranscriptRowSchema = z.object({
  call_id: z.string(),
  ciphertext: z.instanceof(Buffer),
  key_version: z.number().int(),
  fetched_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type RawTranscriptRow = z.infer<typeof rawTranscriptRowSchema>;

/** Caller supplies plaintext; the repo envelope-encrypts it and records key_version. */
export const putTranscriptInputSchema = z.object({
  callId: z.string().min(1),
  transcript: z.string(),
});
export type PutTranscriptInput = z.infer<typeof putTranscriptInputSchema>;
