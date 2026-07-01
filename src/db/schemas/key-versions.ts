import { z } from 'zod';
import { keyVersionStatusSchema } from '../enums.js';

/** key_versions — DEK metadata + external reference only. No key bytes. PK: key_version. */
export const keyVersionRowSchema = z.object({
  key_version: z.number().int(),
  status: keyVersionStatusSchema,
  wrapped_dek_ref: z.string(),
  kek_version: z.string(),
  created_at: z.date(),
  destroyed_at: z.date().nullable(),
});
export type KeyVersionRow = z.infer<typeof keyVersionRowSchema>;

export const keyVersionInsertSchema = z.object({
  keyVersion: z.number().int().positive(),
  status: keyVersionStatusSchema,
  wrappedDekRef: z.string().min(1),
  kekVersion: z.string().min(1),
});
export type KeyVersionInsert = z.infer<typeof keyVersionInsertSchema>;
