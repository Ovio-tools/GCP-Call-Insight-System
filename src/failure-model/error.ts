import { z } from 'zod';
import { type Severity, severitySchema } from '../db/enums.js';
import { isContentField } from '../logging/redaction.js';
import { configSchema } from '../config/schema.js';
import {
  type CallsState,
  type ErrorCode,
  type ProcessingState,
  type RootCauseCategory,
  callsStateSchema,
  errorCodeSchema,
  isPipelineStage,
  isValidComponent,
  processingStateSchema,
  rootCauseCategorySchema,
} from './categories.js';
import { REMEDIATION_CATALOG, catalogFor } from './catalog.js';
import { severityFor } from './severity.js';

/**
 * The typed §4 error object, its zod boundary schema, and the constructors. `context`
 * is sanitized at construction on EVERY path (factory or `new`), so content/free-text
 * can never reach a persisted `failure_snapshot`.
 */

/** Max length of a kept `call_id`/`job_id` value, bounding dedup-key and snapshot size. */
export const MAX_CONTEXT_VALUE_LENGTH = 256;

/** Allowlisted context keys. Everything else is dropped by `sanitizeContext`. */
export const CONTEXT_KEYS = ['call_id', 'job_id', 'environment', 'stage', 'component'] as const;

/** The `environment` context value is validated against the config `NODE_ENV` enum. */
const environmentSchema = configSchema.shape.NODE_ENV;

/**
 * Fail-closed context gate. Keeps only allowlisted keys; drops content-field keys, unknown
 * keys, and enum-typed values that fail their enum; trims `call_id`/`job_id` and drops them
 * when empty or over the length cap. `call_id`/`job_id` VALUES are trusted as safe system
 * identifiers by project policy (they flow through logs raw); no value-level content
 * detection is promised for them.
 */
export function sanitizeContext(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isContentField(key)) continue;
    if (!(CONTEXT_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value !== 'string') continue;

    if (key === 'call_id' || key === 'job_id') {
      const trimmed = value.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_CONTEXT_VALUE_LENGTH) continue;
      out[key] = trimmed;
    } else if (key === 'environment') {
      if (environmentSchema.safeParse(value).success) out[key] = value;
    } else if (key === 'stage') {
      if (isPipelineStage(value)) out[key] = value;
    } else if (key === 'component') {
      if (isValidComponent(value)) out[key] = value;
    }
  }
  return out;
}

/** The catalog-derived fields a `FailureError` must match its `error_code` on (severity exempt). */
const CATALOG_DERIVED_FIELDS = [
  'root_cause_category',
  'impact',
  'remediation_now',
  'remediation_fix',
  'data_safe',
  'calls_state',
  'owner',
  'runbook_ref',
] as const;

/**
 * The field-validity boundary. Composes the real sub-schemas, sanitizes `context` via a
 * transform, and enforces catalog consistency: every catalog-derived field must equal the
 * catalog entry for `error_code` (severity is exempt — overrides are supported). This makes
 * a hand-built `new FailureError({...})` as trustworthy as the `createFailure` factory.
 */
export const failureFieldsSchema = z
  .object({
    error_code: errorCodeSchema,
    root_cause_category: rootCauseCategorySchema,
    severity: severitySchema,
    impact: z.string().min(1),
    processing_state: processingStateSchema,
    remediation_now: z.string().min(1),
    remediation_fix: z.string().min(1),
    data_safe: z.boolean(),
    calls_state: callsStateSchema,
    owner: z.string().min(1),
    runbook_ref: z.string().min(1),
    context: z.record(z.string(), z.string()).transform(sanitizeContext),
  })
  .superRefine((fields, ctx) => {
    const entry = REMEDIATION_CATALOG[fields.error_code];
    if (!entry) return;
    const catalogValues: Record<(typeof CATALOG_DERIVED_FIELDS)[number], unknown> = {
      root_cause_category: entry.rootCauseCategory,
      impact: entry.impact,
      remediation_now: entry.remediationNow,
      remediation_fix: entry.remediationFix,
      data_safe: entry.dataSafe,
      calls_state: entry.callsState,
      owner: entry.owner,
      runbook_ref: entry.runbookRef,
    };
    for (const field of CATALOG_DERIVED_FIELDS) {
      if (fields[field] !== catalogValues[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} does not match the catalog entry for ${fields.error_code}`,
          path: [field],
        });
      }
    }
  });

export type FailureFields = z.infer<typeof failureFieldsSchema>;

/** A structured operational failure carrying the full §4 field set (CLAUDE.md §4). */
export class FailureError extends Error implements FailureFields {
  readonly error_code: ErrorCode;
  /** Alias of `error_code`, matching the local error convention (`DalError`/`FatalBootError`). */
  readonly code: ErrorCode;
  readonly root_cause_category: RootCauseCategory;
  readonly severity: Severity;
  readonly impact: string;
  readonly processing_state: ProcessingState;
  readonly remediation_now: string;
  readonly remediation_fix: string;
  readonly data_safe: boolean;
  readonly calls_state: CallsState;
  readonly owner: string;
  readonly runbook_ref: string;
  readonly context: Record<string, string>;

  /**
   * No caller-supplied message: a free-text message could smuggle context/PII, so the
   * message is always `${error_code}: ${impact}` (catalog text only). `fields` is parsed
   * through {@link failureFieldsSchema}, which sanitizes context and enforces catalog
   * consistency.
   */
  constructor(fields: FailureFields) {
    const parsed = failureFieldsSchema.parse(fields);
    super(`${parsed.error_code}: ${parsed.impact}`);
    this.name = 'FailureError';
    this.error_code = parsed.error_code;
    this.code = parsed.error_code;
    this.root_cause_category = parsed.root_cause_category;
    this.severity = parsed.severity;
    this.impact = parsed.impact;
    this.processing_state = parsed.processing_state;
    this.remediation_now = parsed.remediation_now;
    this.remediation_fix = parsed.remediation_fix;
    this.data_safe = parsed.data_safe;
    this.calls_state = parsed.calls_state;
    this.owner = parsed.owner;
    this.runbook_ref = parsed.runbook_ref;
    this.context = parsed.context;
  }
}

export interface CreateFailureOptions {
  /** Situational: whether the pipeline is paused, degraded, or continuing for this failure. */
  processingState: ProcessingState;
  /** Sanitized-on-store identifiers (call_id, job_id, environment, stage, component). */
  context?: Record<string, string>;
  /** Override the default severity for this occurrence. */
  severity?: Severity;
}

/**
 * The canonical builder. Fills every catalog-derived field from {@link catalogFor} and the
 * default severity from {@link severityFor} (unless overridden); the caller supplies the
 * situational `processing_state` and `context`. Throws on an unknown code (no silent default).
 */
export function createFailure(code: ErrorCode, opts: CreateFailureOptions): FailureError {
  const entry = catalogFor(code);
  return new FailureError({
    error_code: code,
    root_cause_category: entry.rootCauseCategory,
    severity: opts.severity ?? severityFor(code),
    impact: entry.impact,
    processing_state: opts.processingState,
    remediation_now: entry.remediationNow,
    remediation_fix: entry.remediationFix,
    data_safe: entry.dataSafe,
    calls_state: entry.callsState,
    owner: entry.owner,
    runbook_ref: entry.runbookRef,
    context: opts.context ?? {},
  });
}
