/**
 * Record a §0.2 consent gate in `consent_gates` (launch-readiness operator tool).
 *
 * One gate per invocation. Validates the gate name against the canonical vocabulary,
 * requires a human-readable evidence note, is idempotent (skips a gate already
 * recorded unless --force), and reports which required processing gates remain.
 *
 * Usage:
 *   npm run record-consent -- --gate <gate_type> --by "<name>" --note "<one-line note>"
 *   npm run record-consent -- --gate dialpad_recording_consent --by "Jane Doe" \
 *     --note "Eric confirmed recordings in writing, email 2026-06-30"
 */
import {
  REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
} from '../sample-validation/index.js';

export interface RecordConsentArgs {
  gateType: string;
  recordedBy: string;
  note: string;
  force: boolean;
}

/** The canonical gate vocabulary — the five §0.2 processing gates plus the conditional
 * ServiceTitan matching consent. Sourced from gates.ts so the CLI and the gate-check
 * can never drift. */
export const ALLOWED_GATE_TYPES: readonly string[] = [
  ...REQUIRED_PROCESSING_GATE_TYPES,
  SERVICETITAN_MATCHING_CONSENT_GATE,
];

export function parseRecordConsentArgs(argv: readonly string[]): RecordConsentArgs {
  const reqNonEmpty = (flag: string): string => {
    const i = argv.indexOf(flag);
    const raw = i >= 0 ? argv[i + 1] : undefined;
    if (raw === undefined || raw.startsWith('--')) throw new Error(`missing required ${flag}`);
    const trimmed = raw.trim();
    if (trimmed === '') throw new Error(`${flag} must not be empty`);
    return trimmed;
  };

  const gateType = reqNonEmpty('--gate');
  if (!ALLOWED_GATE_TYPES.includes(gateType)) {
    throw new Error(`--gate must be one of: ${ALLOWED_GATE_TYPES.join(', ')} (got "${gateType}")`);
  }
  const recordedBy = reqNonEmpty('--by');
  const note = reqNonEmpty('--note');
  const force = argv.includes('--force');
  return { gateType, recordedBy, note, force };
}
