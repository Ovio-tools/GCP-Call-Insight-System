import { assertNoContentFields } from '../logging/redaction.js';
import { type ReviewDetail, type ReviewList, reviewDetailSchema, reviewListSchema } from './dto.js';

/**
 * The no-egress backstop for the review surface (Task 6.2), mirroring the status surface's
 * serializer. Two checks before any DTO leaves the process:
 *  1. {@link assertNoContentFields} scans every key recursively and THROWS on a known content/PII
 *     field name (`transcript`, `customer_language`, `phone`, `name`, …) — so a smuggled raw
 *     field fails loudly here. `redacted_content` is a distinct, intentionally-allowed key (its
 *     value already passed the value-level residual scan).
 *  2. Re-validate through the DTO schema, which admits only the allowlisted fields.
 */
export function serializeReviewList(dto: ReviewList): ReviewList {
  assertNoContentFields(dto);
  return reviewListSchema.parse(dto);
}

export function serializeReviewDetail(dto: ReviewDetail): ReviewDetail {
  assertNoContentFields(dto);
  return reviewDetailSchema.parse(dto);
}
