import { fileURLToPath } from 'node:url';
import { loadFixtures } from '../support/fixture-loader.js';
import type { ParseFailureKind, TechnicianNoteRecord } from '../../src/technician-notes/index.js';

/**
 * The shared golden-fixture corpus for the technician-note module: hand-labeled REDACTED
 * transcripts paired with the model response a correct model returns for each.
 *
 * `expected.record` is the parse-level expectation. The optional fields carry the gate-level
 * expectations so one fixture can drive prompt, parse, gate, and generator suites without
 * restating the transcript in each.
 */
export interface NoteFixture {
  name: string;
  redactedTranscript: string;
  modelResponse: { text: string | null; stopReason: string | null; usagePresent?: boolean };
  expected: { record: TechnicianNoteRecord } | { failure: ParseFailureKind };
  /** The exact gap list `computeNotEstablished` must produce, in REQUIRED_FOR_DISPATCH order. */
  expectedNotEstablished?: string[];
  /** Set on fixtures that deliberately plant residual PII in a narrative field. */
  expectedResidual?: { fieldsNulled: string[]; categories: string[] };
  /** Set on the prompt-injection fixture. */
  injection?: boolean;
}

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/technician-notes', import.meta.url));

export const noteFixtures: NoteFixture[] = loadFixtures<NoteFixture>(FIXTURES_DIR);

/** Fixtures whose model response is expected to validate (i.e. everything but negative cases). */
export const validFixtures = noteFixtures.filter((f) => 'record' in f.expected);

export function fixtureByName(name: string): NoteFixture {
  const found = noteFixtures.find((f) => f.name === name);
  if (!found) throw new Error(`no technician-note fixture named ${name}`);
  return found;
}

/** The validated record a fixture expects. Throws on a negative fixture. */
export function expectedRecord(f: NoteFixture): TechnicianNoteRecord {
  if (!('record' in f.expected)) throw new Error(`${f.name} is a negative fixture`);
  return f.expected.record;
}
