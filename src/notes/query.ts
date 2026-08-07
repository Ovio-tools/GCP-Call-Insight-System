import { z } from 'zod';
import { serviceCategorySchema, urgencySchema } from '../db/enums.js';
import type { Config } from '../config/schema.js';
import type { NoteQueryFilters } from '../db/repositories/technician-notes-repo.js';
import { isValidDateInput, toDateBounds } from '../knowledge/query.js';
import { noteReviewStateSchema } from './dto.js';

/**
 * Note-review list request schema (ADR 0009), modeled on `src/knowledge/query.ts`.
 *
 * The UTC day-boundary rules (`isValidDateInput` / `toDateBounds`) are IMPORTED from the knowledge
 * surface rather than reimplemented: `from=2026-07-01&to=2026-07-01` must mean the same day on both
 * screens, and calendar-overflow rejection (`2026-02-30`) is subtle enough that a second copy would
 * drift. Both screens filter on the CALL's date, so they must agree exactly.
 *
 * `.strict()` so a stray key is `REQUEST_MALFORMED` rather than silently stripped. There is no free-
 * text `q` here — every filter is a controlled vocabulary except the two date bounds, which are the
 * only user-typed strings that reflect back into the page.
 */

/**
 * Treat an empty string as absent BEFORE the inner schema runs. An HTML GET `<form>` submits every
 * untouched `<select>` as `name=` and every blank date box as `from=`, so an empty string reaches us
 * for filters the user never set. The key is unchanged, so `.strict()` still rejects genuinely
 * unknown keys and a non-empty bad value (`urgency=nope`) still fails.
 */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

function filterShape() {
  return {
    service_category: emptyToUndefined(serviceCategorySchema.optional()),
    urgency: emptyToUndefined(urgencySchema.optional()),
    review_state: emptyToUndefined(noteReviewStateSchema.optional()),
    from: emptyToUndefined(
      z.string().refine(isValidDateInput, { message: 'invalid date' }).optional(),
    ),
    to: emptyToUndefined(
      z.string().refine(isValidDateInput, { message: 'invalid date' }).optional(),
    ),
  };
}

/** Cross-field guard: when both bounds are present, `from` must resolve before `to`. */
function dateRangeRefine(
  data: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.from === undefined || data.to === undefined) return;
  try {
    toDateBounds({ from: data.from, to: data.to });
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'from must be before to' });
  }
}

/** LIST schema: filters + config-derived pagination (`page` ≥1 default 1; `page_size` default
 * `NOTES_PAGE_SIZE_DEFAULT`, clamped to `[1, NOTES_PAGE_SIZE_MAX]`). A factory, not a constant,
 * because the bounds are per-environment config. */
export function makeListQuerySchema(config: Config) {
  return z
    .object({
      ...filterShape(),
      page: z.coerce.number().int().positive().default(1),
      page_size: z.coerce
        .number()
        .int()
        .positive()
        .default(config.NOTES_PAGE_SIZE_DEFAULT)
        .transform((n) => Math.min(n, config.NOTES_PAGE_SIZE_MAX)),
    })
    .strict()
    .superRefine(dateRangeRefine);
}

export type NoteListQuery = z.infer<ReturnType<typeof makeListQuerySchema>>;

/** The echoed filter shape. Every field carries `| undefined` so a `.safeParse` result assigns
 * cleanly under `exactOptionalPropertyTypes`. */
export interface EchoedNoteFilters {
  service_category?: NoteListQuery['service_category'] | undefined;
  urgency?: NoteListQuery['urgency'] | undefined;
  review_state?: NoteListQuery['review_state'] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The validated filter values to echo back in the DTO (drops pagination). */
export function toEchoedFilters(parsed: EchoedNoteFilters): EchoedNoteFilters {
  return {
    ...(parsed.service_category ? { service_category: parsed.service_category } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...(parsed.review_state ? { review_state: parsed.review_state } : {}),
    ...(parsed.from ? { from: parsed.from } : {}),
    ...(parsed.to ? { to: parsed.to } : {}),
  };
}

/** Map validated request filters to the repo's parameterized filter contract. */
export function toRepoFilters(parsed: EchoedNoteFilters): NoteQueryFilters {
  return {
    ...(parsed.service_category ? { serviceCategory: parsed.service_category } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...(parsed.review_state ? { reviewState: parsed.review_state } : {}),
    ...toDateBounds({
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
    }),
  };
}
