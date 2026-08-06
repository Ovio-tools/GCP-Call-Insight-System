/**
 * Technician-note batch generator (ADR 0009) — turns a stored redacted transcript into the
 * job-readiness note a technician reads before a visit.
 *
 * NOT a pipeline stage. A note is derived and optional, so nothing here holds a call or writes a
 * review_queue row; a hold would block the CLEAN retention purge and silently extend PII
 * retention for a cosmetic failure. See `docs/adr/0009-technician-notes-durable-and-feedback-append-only.md`.
 *
 * Module layout mirrors src/pipeline/extract/: prompt / parse / gates are PURE, generate.ts is the
 * only per-call impure module, run.ts is the batch orchestrator, and the CLI entrypoint lives at
 * src/scripts/generate-technician-notes.ts.
 */

export { TechnicianNoteError, type TechnicianNoteRefusalReason } from './errors.js';

export {
  REQUIRED_FOR_DISPATCH,
  type NoteResidualResult,
  assertDispatchSummaryLength,
  computeNotEstablished,
  scanNoteForResidual,
} from './gates.js';

export {
  TECHNICIAN_NOTE_STAGE,
  type NoteGenerationResult,
  type NoteOutcome,
  type TechnicianNoteGenerator,
  type TechnicianNoteGeneratorDeps,
  createTechnicianNoteGenerator,
} from './generate.js';

export {
  type ParseFailureKind,
  type ParseOutcome,
  type TechnicianNoteRecord,
  parseTechnicianNote,
  technicianNoteRecordSchema,
} from './parse.js';

export {
  TECHNICIAN_NOTE_PROMPT_VERSION,
  TECHNICIAN_NOTE_SCHEMA_VERSION,
  TECHNICIAN_NOTE_SYSTEM_PROMPT,
  buildTechnicianNoteRetryUserMessage,
  buildTechnicianNoteUserMessage,
} from './prompt.js';

export {
  TECHNICIAN_NOTES_ADVISORY_LOCK_KEY,
  type RunTechnicianNotesDeps,
  type TechnicianNoteRunSummary,
  runTechnicianNotes,
} from './run.js';
