import type { Pool } from 'pg';
import { listByType } from '../db/repositories/consent-gates-repo.js';
import { SampleValidationError } from './errors.js';

/**
 * The §0.2 processing-gate check for the sample-validation harness (Task 11.1).
 *
 * The harness is the ONE consented exception to the synthetic-only rule, and it earns that
 * exception ONLY when every §0.2 processing gate is already recorded in `consent_gates`:
 *  - Dialpad recording / share consent,
 *  - the signed services agreement,
 *  - the signed data-processing addendum,
 *  - the Anthropic no-training confirmation,
 *  - the Anthropic API data-retention confirmation.
 *
 * The ServiceTitan matching consent (§12.0) is conditional: required ONLY when the run exercises
 * ServiceTitan / `match_keys` / matching behavior, and NOT required otherwise.
 *
 * `gate_type` is free text in `consent_gates`; these constants pin the canonical vocabulary the
 * harness reads and the operator records against. A gate is "present" when at least one row of its
 * type exists.
 */

export const SAMPLE_VALIDATION_GATES = {
  dialpad_recording_consent: 'dialpad_recording_consent',
  signed_services_agreement: 'signed_services_agreement',
  signed_data_processing_addendum: 'signed_data_processing_addendum',
  anthropic_no_training_confirmation: 'anthropic_no_training_confirmation',
  anthropic_data_retention_confirmation: 'anthropic_data_retention_confirmation',
} as const;

/** The five §0.2 processing gates, in the plan's stated order. Every one is required. */
export const REQUIRED_PROCESSING_GATE_TYPES = [
  SAMPLE_VALIDATION_GATES.dialpad_recording_consent,
  SAMPLE_VALIDATION_GATES.signed_services_agreement,
  SAMPLE_VALIDATION_GATES.signed_data_processing_addendum,
  SAMPLE_VALIDATION_GATES.anthropic_no_training_confirmation,
  SAMPLE_VALIDATION_GATES.anthropic_data_retention_confirmation,
] as const;

/** The conditional §12.0 matching consent — required only when the run touches ServiceTitan. */
export const SERVICETITAN_MATCHING_CONSENT_GATE = 'servicetitan_matching_consent';

export interface GateCheckOptions {
  /** True when this validation run exercises ServiceTitan / match-key behavior. */
  requireServiceTitanMatching: boolean;
}

export interface GateCheckResult {
  ok: boolean;
  /** Required gate types not yet recorded, in the order they are required. */
  missing: string[];
}

async function isRecorded(pool: Pool, gateType: string): Promise<boolean> {
  const rows = await listByType(pool, gateType);
  return rows.length > 0;
}

/** The full list of gate types required for a run, including the conditional matching consent. */
export function requiredGateTypesFor(options: GateCheckOptions): string[] {
  return options.requireServiceTitanMatching
    ? [...REQUIRED_PROCESSING_GATE_TYPES, SERVICETITAN_MATCHING_CONSENT_GATE]
    : [...REQUIRED_PROCESSING_GATE_TYPES];
}

/** Which required gates are recorded. A read only — no side effects. */
export async function checkProcessingGates(
  pool: Pool,
  options: GateCheckOptions,
): Promise<GateCheckResult> {
  const required = requiredGateTypesFor(options);
  const missing: string[] = [];
  for (const gateType of required) {
    if (!(await isRecorded(pool, gateType))) missing.push(gateType);
  }
  return { ok: missing.length === 0, missing };
}

/** Throw `missing_consent_gates` unless every required gate is recorded. Blocks before side effects. */
export async function assertProcessingGates(pool: Pool, options: GateCheckOptions): Promise<void> {
  const result = await checkProcessingGates(pool, options);
  if (!result.ok) {
    throw new SampleValidationError(
      'missing_consent_gates',
      `refusing to run: ${result.missing.length} required consent gate(s) are not recorded`,
      { missing: result.missing },
    );
  }
}
