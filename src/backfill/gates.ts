import type { Pool } from 'pg';
import { checkProcessingGates } from '../sample-validation/gates.js';
import { BackfillError } from './errors.js';

/**
 * The execution options that determine whether a backfill run performs ServiceTitan match-key
 * reads/writes. Kept as an explicit object (not a bare flag) so the §12.0 matching-consent
 * requirement is DERIVED from what the run actually does, never asserted independently.
 */
export interface BackfillExecOptions {
  /** True when the run would write `match_keys` (the `--match-keys` path). Match-key write-back is a
   * Phase-12 concern and is not implemented yet; when true the orchestrator ALSO fails fast with
   * `match_keys_unsupported`, so this never silently bypasses the ST gate. */
  writesMatchKeys: boolean;
}

/**
 * Whether the §0.2 ServiceTitan matching consent (§12.0) is required for this run — true iff the run
 * actually touches match keys. Pure. Mirrors the sample-validation harness's `requireServiceTitanMatching`
 * derivation (Task 11.1) but sourced from the backfill exec options rather than a `--servicetitan` flag.
 */
export function deriveServiceTitanMatchingRequirement(execOptions: BackfillExecOptions): boolean {
  return execOptions.writesMatchKeys;
}

/**
 * The §0.2 processing-gate check for the backfill runner (Task 11.2). The backfill is gated on ALL
 * §0.2 processing, legal, and vendor-retention gates being recorded in `consent_gates`; the
 * conditional ServiceTitan matching consent is required ONLY when the run writes match keys. Wraps
 * the generic {@link checkProcessingGates} helper (shared with Task 11.1) and throws
 * `BackfillError('missing_consent_gates', …, {missing})` BEFORE any fetch/model/enqueue/pipeline
 * work. A read only — no side effects.
 */
export async function assertBackfillProcessingGates(
  pool: Pool,
  execOptions: BackfillExecOptions,
): Promise<void> {
  const result = await checkProcessingGates(pool, {
    requireServiceTitanMatching: deriveServiceTitanMatchingRequirement(execOptions),
  });
  if (!result.ok) {
    throw new BackfillError(
      'missing_consent_gates',
      `refusing to run: ${result.missing.length} required consent gate(s) are not recorded`,
      { missing: result.missing },
    );
  }
}
