import { z } from 'zod';
import { callIntentSchema, serviceCategorySchema, urgencySchema } from '../db/enums.js';
import type { Config } from '../config/schema.js';
import type { KnowledgeQueryFilters } from '../db/repositories/structured-knowledge-repo.js';

/**
 * Knowledge-surface request schemas + the shared date parser (Task 10.1).
 *
 * Two schema FACTORIES because the view's page-size bounds are per-environment config (Finding 2):
 * `makeViewQuerySchema(config)` adds config-derived pagination; `makeExportQuerySchema()` omits it.
 * BOTH are `.strict()` — a stray key (e.g. `page` on an export, or `sentiment` anywhere) is rejected
 * so the route surfaces `REQUEST_MALFORMED`. `q` is trimmed/bounded; enums come straight from the DB
 * enum schemas; `sentiment` is never accepted.
 */

const MAX_Q_LENGTH = 200;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/;
const MS_PER_DAY = 86_400_000;

/**
 * Resolve one `from`/`to` value to its UTC instant bound, or `null` if it is not a valid date form.
 * - date-only `YYYY-MM-DD`: `from` → start-of-day UTC; `to` → the NEXT UTC day (so `< toExclusive`
 *   includes the named day).
 * - full ISO timestamp: `Z`/explicit offset honored; an offset-less timestamp is treated as UTC
 *   (a `Z` is appended before `Date` construction so parsing is deterministic across environments).
 */
/** True iff `Y-M-D` is a real calendar date (rejects month/day overflow like `2026-02-30`). */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function resolveBound(value: string, edge: 'from' | 'to'): Date | null {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    // Reject overflow (e.g. 2026-13-01, 2026-02-30) — Date.UTC would silently roll it forward.
    if (!isRealCalendarDate(y, m, d)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return edge === 'to' ? new Date(dt.getTime() + MS_PER_DAY) : dt;
  }
  if (ISO_DATETIME.test(value)) {
    // The DATE portion (`YYYY-MM-DD`) must be a real calendar day: `new Date` normalizes an
    // impossible day (e.g. Feb 30 → Mar 2) instead of rejecting it, which would query the wrong day.
    const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
    if (!isRealCalendarDate(y, m, d)) return null;
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
    const dt = new Date(hasZone ? value : `${value}Z`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

/** True iff `value` is a date-only or full-ISO-timestamp form this surface accepts. */
export function isValidDateInput(value: string): boolean {
  return resolveBound(value, 'from') !== null;
}

/**
 * Compute the `[fromInclusive, toExclusive)` bounds for the WHERE clause. Throws `RangeError` on an
 * unparseable value or when `from >= to` (a malformed range) — the route maps that to
 * `REQUEST_MALFORMED`; the message carries no user value.
 */
export function toDateBounds(filters: { from?: string; to?: string }): {
  fromInclusive?: Date;
  toExclusive?: Date;
} {
  const bound = (value: string | undefined, edge: 'from' | 'to'): Date | undefined => {
    if (value === undefined) return undefined;
    const d = resolveBound(value, edge);
    if (d === null) throw new RangeError('invalid date bound');
    return d;
  };
  const fromInclusive = bound(filters.from, 'from');
  const toExclusive = bound(filters.to, 'to');
  if (fromInclusive && toExclusive && fromInclusive.getTime() >= toExclusive.getTime()) {
    throw new RangeError('from must be before to');
  }
  return {
    ...(fromInclusive ? { fromInclusive } : {}),
    ...(toExclusive ? { toExclusive } : {}),
  };
}

/** The filter fields shared by the view and the export schemas. */
function filterShape() {
  return {
    q: z.string().trim().max(MAX_Q_LENGTH).optional(),
    service_category: serviceCategorySchema.optional(),
    call_intent: callIntentSchema.optional(),
    urgency: urgencySchema.optional(),
    from: z.string().refine(isValidDateInput, { message: 'invalid date' }).optional(),
    to: z.string().refine(isValidDateInput, { message: 'invalid date' }).optional(),
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

/** VIEW schema: filters + config-derived pagination (`page` ≥1 default 1; `page_size` default
 * `KNOWLEDGE_PAGE_SIZE_DEFAULT`, clamped to `[1, KNOWLEDGE_PAGE_SIZE_MAX]`). */
export function makeViewQuerySchema(config: Config) {
  return z
    .object({
      ...filterShape(),
      page: z.coerce.number().int().positive().default(1),
      page_size: z.coerce
        .number()
        .int()
        .positive()
        .default(config.KNOWLEDGE_PAGE_SIZE_DEFAULT)
        .transform((n) => Math.min(n, config.KNOWLEDGE_PAGE_SIZE_MAX)),
    })
    .strict()
    .superRefine(dateRangeRefine);
}

/** EXPORT schema: filters only, `.strict()` so a stray `page`/`page_size` is rejected. */
export function makeExportQuerySchema() {
  return z.object(filterShape()).strict().superRefine(dateRangeRefine);
}

export type KnowledgeViewQuery = z.infer<ReturnType<typeof makeViewQuerySchema>>;
export type KnowledgeExportQuery = z.infer<ReturnType<typeof makeExportQuerySchema>>;

/** The echoed filter DTO shape (raw validated filter values — never pagination). Optional fields
 * carry `| undefined` so a `.safeParse` result assigns cleanly under `exactOptionalPropertyTypes`. */
export interface EchoedFilters {
  q?: string | undefined;
  service_category?: KnowledgeViewQuery['service_category'] | undefined;
  call_intent?: KnowledgeViewQuery['call_intent'] | undefined;
  urgency?: KnowledgeViewQuery['urgency'] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The validated filter values to echo back in the DTO (drops pagination and empty `q`). */
export function toEchoedFilters(parsed: EchoedFilters): EchoedFilters {
  return {
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(parsed.service_category ? { service_category: parsed.service_category } : {}),
    ...(parsed.call_intent ? { call_intent: parsed.call_intent } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...(parsed.from ? { from: parsed.from } : {}),
    ...(parsed.to ? { to: parsed.to } : {}),
  };
}

/** Map validated request filters to the repo's parameterized filter contract. */
export function toRepoFilters(parsed: EchoedFilters): KnowledgeQueryFilters {
  return {
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(parsed.service_category ? { serviceCategory: parsed.service_category } : {}),
    ...(parsed.call_intent ? { callIntent: parsed.call_intent } : {}),
    ...(parsed.urgency ? { urgency: parsed.urgency } : {}),
    ...toDateBounds({
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
    }),
  };
}
