import { z } from 'zod';

/** token_vault — per-call token -> envelope-encrypted original value. RESTRICTED role
 * only. Purgeable. PK: (call_id, token). */
export const tokenVaultRowSchema = z.object({
  call_id: z.string(),
  token: z.string(),
  ciphertext: z.instanceof(Buffer),
  key_version: z.number().int(),
  created_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type TokenVaultRow = z.infer<typeof tokenVaultRowSchema>;

/** Caller supplies the token label and the plaintext value; the repo encrypts it. */
export const putTokenInputSchema = z.object({
  callId: z.string().min(1),
  token: z.string().min(1),
  plaintext: z.instanceof(Buffer),
});
export type PutTokenInput = z.infer<typeof putTokenInputSchema>;
