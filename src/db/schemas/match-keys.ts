import { z } from 'zod';

/**
 * match_keys — salted HMAC digests of phone/name for ServiceTitan matching. RESTRICTED
 * role only. Purgeable. PK: id.
 *
 * NOTE: these are HMAC digests, NOT envelope-encrypted ciphertext. They are one-way and
 * never decrypted; the DAL stores/reads the `bytea` digests produced upstream, and
 * `key_version` records which HMAC key/salt version was used. Only `token_vault` and
 * `raw_transcripts` pass through the encrypt/decrypt helper.
 */
export const matchKeyRowSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string(),
  phone_hmac: z.instanceof(Buffer).nullable(),
  name_hmac: z.instanceof(Buffer).nullable(),
  key_version: z.number().int(),
  created_at: z.date(),
  retention_eligible_at: z.date().nullable(),
  soft_deleted_at: z.date().nullable(),
  hard_deleted_at: z.date().nullable(),
});
export type MatchKeyRow = z.infer<typeof matchKeyRowSchema>;

export const putMatchKeysInputSchema = z
  .object({
    callId: z.string().min(1),
    phoneHmac: z.instanceof(Buffer).nullable().optional(),
    nameHmac: z.instanceof(Buffer).nullable().optional(),
    keyVersion: z.number().int().positive(),
  })
  .refine((v) => v.phoneHmac != null || v.nameHmac != null, {
    message: 'at least one of phoneHmac / nameHmac is required',
  });
export type PutMatchKeysInput = z.infer<typeof putMatchKeysInputSchema>;
