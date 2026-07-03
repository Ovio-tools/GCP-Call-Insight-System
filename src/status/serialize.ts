import { assertNoContentFields } from '../logging/redaction.js';
import { type StatusDTO, statusDtoSchema } from './dto.js';

/**
 * The hard privacy line for the status surface (Task 7.3, plan §4): a defense-in-depth guard
 * run over the DTO before it leaves the process, mirroring the existing no-PII-egress tests.
 *
 * Two checks:
 *  1. {@link assertNoContentFields} scans every key of the RAW input recursively and THROWS
 *     on a known content/PII field name — run FIRST, before zod would silently strip an
 *     unknown key, so a smuggled `transcript` / `customer_language` / `phone` / `name` fails
 *     loudly here rather than shipping.
 *  2. Re-validate through {@link statusDtoSchema} — the DTO can hold ONLY the allowlisted
 *     primitives (labels, states, counts, timestamps, budget numbers, error codes, runbook
 *     refs, sanitized summary strings); anything else is dropped.
 *
 * Returns the validated DTO. Both the HTML page and the JSON endpoint serialize from this.
 */
export function serializeStatus(dto: StatusDTO): StatusDTO {
  assertNoContentFields(dto);
  return statusDtoSchema.parse(dto);
}
