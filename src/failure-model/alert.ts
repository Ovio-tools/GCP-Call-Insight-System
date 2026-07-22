import { z } from 'zod';
import { type Severity } from '../db/enums.js';
import { assertNoContentFields, isContentField } from '../logging/redaction.js';
import { configObjectSchema } from '../config/schema.js';
import { type CallsState, type ErrorCode } from './categories.js';
import { SAME_AS_IMMEDIATE, catalogFor } from './catalog.js';
import { DEDUP_SCOPE_PRIORITY } from './dedup.js';
import { type FailureFields, failureFieldsSchema } from './error.js';

/**
 * The plain-language alert contract (CLAUDE.md §4): what broke, likely root cause, impact,
 * immediate remediation, longer-term fix, whether data is safe, whether calls are held /
 * retried / dropped, a runbook pointer, timestamp, and environment.
 *
 * `affectedScope` lists the present context KEY NAMES only (never values) — operators locate
 * the affected records via `alert_events.failure_snapshot.context`. No context value is ever
 * placed in a `FormattedAlert`.
 */
export interface FormattedAlert {
  readonly errorCode: ErrorCode;
  readonly severity: Severity;
  /** Plain-language sentence from the catalog — never the raw code (that is `errorCode`). */
  readonly whatBroke: string;
  /** Plain-language sentence from the catalog — never the raw category code. */
  readonly likelyRootCause: string;
  readonly impact: string;
  readonly immediateRemediation: string;
  readonly longerTermFix: string;
  readonly dataSafe: boolean;
  readonly callsState: CallsState;
  readonly runbookRef: string;
  readonly timestamp: string;
  readonly environment: string;
  /** Present context key names, in the fixed dedup priority order. Never values. */
  readonly affectedScope: string[];
}

export interface FormatAlertOptions {
  /** Deployment environment; validated against the config `NODE_ENV` enum. */
  environment: string;
  /** ISO-8601 timestamp; validated with `z.string().datetime()`. */
  timestamp: string;
}

const environmentSchema = configObjectSchema.shape.NODE_ENV;
const timestampSchema = z.string().datetime();

const SAME_AS_IMMEDIATE_TEXT = 'Same as the immediate step.';

/**
 * Render a `FailureError`/`FailureFields` into the plain-language alert contract. Parses
 * `error` through {@link failureFieldsSchema} first (sanitizing context + enforcing catalog
 * consistency), so a hand-built `FailureFields` with bogus fields throws rather than rendering
 * wrong text. `opts.environment`/`opts.timestamp` are validated and throw when invalid.
 */
export function formatAlert(error: FailureFields, opts: FormatAlertOptions): FormattedAlert {
  const parsed = failureFieldsSchema.parse(error);
  const environment = environmentSchema.parse(opts.environment);
  const timestamp = timestampSchema.parse(opts.timestamp);

  const context = parsed.context;
  const affectedScope = DEDUP_SCOPE_PRIORITY.filter(
    (key) => context[key] !== undefined && !isContentField(key),
  );

  // Plain-language sentences come from the catalog (the code's single source of truth), so a
  // reader is never shown the machine code as the explanation of itself. The raw code stays
  // available as `errorCode` for the header/correlation.
  const catalog = catalogFor(parsed.error_code);

  const formatted: FormattedAlert = {
    errorCode: parsed.error_code,
    severity: parsed.severity,
    whatBroke: catalog.whatBroke,
    likelyRootCause: catalog.likelyCause,
    impact: parsed.impact,
    immediateRemediation: parsed.remediation_now,
    longerTermFix:
      parsed.remediation_fix === SAME_AS_IMMEDIATE
        ? SAME_AS_IMMEDIATE_TEXT
        : parsed.remediation_fix,
    dataSafe: parsed.data_safe,
    callsState: parsed.calls_state,
    runbookRef: parsed.runbook_ref,
    timestamp,
    environment,
    affectedScope: [...affectedScope],
  };

  // Belt-and-suspenders: the guard refuses to emit any known content-field key.
  assertNoContentFields(formatted);
  return formatted;
}

/** Render a `FormattedAlert` to a human string. Private — the only public path is via the error. */
function renderFormatted(a: FormattedAlert): string {
  return [
    `[${a.severity}] ${a.errorCode} in ${a.environment} at ${a.timestamp}`,
    `What broke: ${a.whatBroke}`,
    `Likely root cause: ${a.likelyRootCause}`,
    `Impact: ${a.impact}`,
    `Immediate remediation: ${a.immediateRemediation}`,
    `Longer-term fix: ${a.longerTermFix}`,
    `Customer data safe: ${a.dataSafe ? 'yes' : 'no'}`,
    `Calls: ${a.callsState}`,
    `Affected: ${a.affectedScope.length > 0 ? a.affectedScope.join(', ') : 'none'}`,
    `Runbook: ${a.runbookRef}`,
  ].join('\n');
}

/**
 * The human string for logs / the status surface. Takes the error (not a `FormattedAlert`) and
 * formats internally, so the only public path is the validated one — a hand-built
 * `FormattedAlert` with arbitrary strings cannot be rendered. Surfaces `affectedScope` key names
 * only, never context values.
 */
export function renderAlertText(error: FailureFields, opts: FormatAlertOptions): string {
  return renderFormatted(formatAlert(error, opts));
}
