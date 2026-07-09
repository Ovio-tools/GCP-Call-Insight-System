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
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { loadConfig } from '../config/index.js';
import { createBootLogger } from '../boot/logger.js';
import { createAppPool } from '../db/index.js';
import { listByType, recordConsent } from '../db/repositories/consent-gates-repo.js';
import {
  checkProcessingGates,
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

export interface RecordConsentResult {
  inserted: boolean;
  alreadyRecorded: boolean;
  existingRecordedBy?: string;
  existingRecordedAt?: Date;
  /** Required §0.2 processing gates not yet recorded (ServiceTitan consent excluded). */
  missingProcessingGates: string[];
}

/** Record the gate if new (or forced); otherwise report it as already recorded. Then
 * compute which required processing gates remain. Pure orchestration over the existing
 * repo + gate-check — no new SQL. */
export async function runRecordConsent(
  pool: Pool,
  input: RecordConsentArgs,
): Promise<RecordConsentResult> {
  const existing = await listByType(pool, input.gateType);
  const first = existing[0];

  let inserted = false;
  let alreadyRecorded = false;
  let existingRecordedBy: string | undefined;
  let existingRecordedAt: Date | undefined;

  if (first !== undefined && !input.force) {
    alreadyRecorded = true;
    existingRecordedBy = first.recorded_by;
    existingRecordedAt = first.recorded_at;
  } else {
    await recordConsent(pool, {
      gateType: input.gateType,
      recordedBy: input.recordedBy,
      evidenceRef: input.note,
    });
    inserted = true;
  }

  const { missing } = await checkProcessingGates(pool, { requireServiceTitanMatching: false });
  return {
    inserted,
    alreadyRecorded,
    ...(existingRecordedBy !== undefined ? { existingRecordedBy } : {}),
    ...(existingRecordedAt !== undefined ? { existingRecordedAt } : {}),
    missingProcessingGates: missing,
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBootLogger({ level: config.LOG_LEVEL, name: 'record-consent' });
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const args = parseRecordConsentArgs(process.argv.slice(2));
  const pool = createAppPool(config.DATABASE_URL);
  try {
    const result = await runRecordConsent(pool, args);
    if (result.alreadyRecorded) {
      logger.info(
        { gateType: args.gateType },
        'consent gate already recorded — no new row written',
      );
      process.stdout.write(
        `Already recorded: ${args.gateType}\n` +
          `  first recorded by ${result.existingRecordedBy ?? 'unknown'} at ` +
          `${result.existingRecordedAt?.toISOString() ?? 'unknown'}\n` +
          `  (use --force to record an additional row)\n`,
      );
    } else {
      logger.info(
        { gateType: args.gateType, recordedBy: args.recordedBy },
        'consent gate recorded',
      );
      process.stdout.write(
        `Recorded consent gate: ${args.gateType}\n` +
          `  recorded by: ${args.recordedBy}\n` +
          `  evidence:    ${args.note}\n`,
      );
    }
    if (result.missingProcessingGates.length === 0) {
      process.stdout.write(`\nAll five §0.2 processing consent gates are now recorded.\n`);
    } else {
      process.stdout.write(
        `\nStill missing ${result.missingProcessingGates.length} required processing gate(s):\n` +
          result.missingProcessingGates.map((g) => `  - ${g}`).join('\n') +
          '\n',
      );
    }
  } finally {
    await pool.end();
  }
}

// Run only when invoked as the entrypoint, never when imported by a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`record-consent failed: ${String(err)}\n`);
    process.exit(1);
  });
}
