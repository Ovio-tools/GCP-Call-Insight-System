import { describe, expect, it } from 'vitest';
import { parseTechnicianNote } from '../../src/technician-notes/index.js';
import { DISPATCH_SUMMARY_MAX_LENGTH } from '../../src/db/schemas/technician-notes.js';
import { expectedRecord, noteFixtures, validFixtures } from './fixtures.js';

/** A schema-valid record, as the plain object the model would emit. */
function goodRecord(): Record<string, unknown> {
  const first = validFixtures[0];
  if (!first) throw new Error('the technician-note fixture corpus is empty');
  return structuredClone(expectedRecord(first));
}

function parseOf(record: Record<string, unknown>): ReturnType<typeof parseTechnicianNote> {
  return parseTechnicianNote({ text: JSON.stringify(record), stopReason: 'end_turn' });
}

describe('technician-note fixture corpus', () => {
  it('loads a non-empty corpus of at least twelve golden fixtures', () => {
    expect(noteFixtures.length).toBeGreaterThanOrEqual(12);
    expect(noteFixtures.filter((f) => f.name.startsWith('golden-')).length).toBeGreaterThanOrEqual(
      12,
    );
  });

  it('covers every required scenario', () => {
    const names = noteFixtures.map((f) => f.name).join(' ');
    for (const scenario of [
      'water-heater',
      'drain-clog',
      'grinder-pump',
      'slab-leak',
      'repeat-visit',
      'home-warranty',
      'tenant-call',
      'after-hours-emergency',
      'csr-quoted-price',
      'access-code-given',
      'hazard',
      'nothing-established',
    ]) {
      expect(names, `missing a fixture for ${scenario}`).toContain(scenario);
    }
  });

  it('parses every fixture’s model response into its expected record', () => {
    for (const f of validFixtures) {
      const outcome = parseTechnicianNote(f.modelResponse);
      expect(outcome.ok, `${f.name} failed to parse`).toBe(true);
      if (outcome.ok) expect(outcome.record).toEqual(expectedRecord(f));
    }
  });

  it('keeps dispatch_summary at or under 800 characters across every fixture', () => {
    for (const f of validFixtures) {
      const summary = expectedRecord(f).dispatch_summary;
      if (summary !== null) {
        expect(summary.length, `${f.name} dispatch_summary too long`).toBeLessThanOrEqual(
          DISPATCH_SUMMARY_MAX_LENGTH,
        );
      }
    }
  });
});

describe('parseTechnicianNote failure precedence', () => {
  it('reports refusal before anything else', () => {
    const outcome = parseTechnicianNote({ text: 'I cannot help', stopReason: 'refusal' });
    expect(outcome).toEqual({ ok: false, failure: 'refusal' });
  });

  it('reports truncation for max_tokens even when the text is valid JSON', () => {
    const outcome = parseTechnicianNote({
      text: JSON.stringify(goodRecord()),
      stopReason: 'max_tokens',
    });
    expect(outcome).toEqual({ ok: false, failure: 'truncated' });
  });

  it('reports unexpected_stop_reason for null and unknown stop reasons', () => {
    for (const stopReason of [null, 'tool_use', 'pause_turn', 'something_new']) {
      const outcome = parseTechnicianNote({ text: JSON.stringify(goodRecord()), stopReason });
      expect(outcome).toEqual({ ok: false, failure: 'unexpected_stop_reason' });
    }
  });

  it('reports empty for null and whitespace-only text', () => {
    for (const text of [null, '', '   \n ']) {
      expect(parseTechnicianNote({ text, stopReason: 'end_turn' })).toEqual({
        ok: false,
        failure: 'empty',
      });
    }
  });

  it('reports non_json for fenced JSON, prose, and trailing content', () => {
    const json = JSON.stringify(goodRecord());
    for (const text of [
      '```json\n' + json + '\n```',
      'Here you go: ' + json,
      json + '\nHope that helps.',
      'not json at all',
    ]) {
      expect(parseTechnicianNote({ text, stopReason: 'end_turn' }).ok).toBe(false);
      const outcome = parseTechnicianNote({ text, stopReason: 'end_turn' });
      if (!outcome.ok) expect(outcome.failure).toBe('non_json');
    }
  });
});

describe('technicianNoteRecordSchema strictness', () => {
  it('rejects a smuggled confidence field', () => {
    const outcome = parseOf({ ...goodRecord(), confidence: 0.9 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('schema_invalid');
  });

  it('rejects a smuggled sentiment or tone field', () => {
    for (const extra of [{ sentiment: 'frustrated' }, { tone: 'angry' }]) {
      const outcome = parseOf({ ...goodRecord(), ...extra });
      expect(outcome.ok).toBe(false);
    }
  });

  it('rejects a model-authored not_established — the gap list is computed in code', () => {
    const outcome = parseOf({ ...goodRecord(), not_established: ['equipment.type'] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toBe('schema_invalid');
      // The summary reports `(root): unrecognized_keys` WITHOUT naming the key: zod puts
      // rejected key names in `message`, which this parser never reads because a message can
      // embed the received value. Losing the key name in the retry hint is the accepted cost
      // of that rule — the retry still tells the model its output had a field it should not.
      expect(outcome.issueSummary?.join(' ')).toContain('unrecognized_keys');
    }
  });

  it('rejects an extra key inside a jsonb group', () => {
    const record = goodRecord();
    (record.equipment as Record<string, unknown>).serial_number = 'abc';
    expect(parseOf(record).ok).toBe(false);
  });

  it('rejects an unknown scope_signal or occupancy', () => {
    expect(parseOf({ ...goodRecord(), scope_signal: 'some_fixture' }).ok).toBe(false);
    expect(parseOf({ ...goodRecord(), occupancy: 'landlord' }).ok).toBe(false);
  });

  it('accepts null for every nullable member — the expected answer on most calls', () => {
    const record = goodRecord();
    record.equipment = {
      type: null,
      brand: null,
      model: null,
      capacity: null,
      approximate_age: null,
      fuel_type: null,
    };
    record.location_on_property = null;
    record.symptom_verbatim = null;
    record.dispatch_summary = null;
    expect(parseOf(record).ok).toBe(true);
  });
});

describe('dispatch_summary length is a SCHEMA failure, not a truncation', () => {
  it('rejects a summary over 800 characters as schema_invalid', () => {
    const record = goodRecord();
    record.dispatch_summary = 'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH + 1);
    const outcome = parseOf(record);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // schema_invalid is in the retryable set, so an over-long summary earns the bounded
      // retry. 'truncated' would NOT, which is exactly why this must not map to it.
      expect(outcome.failure).toBe('schema_invalid');
      expect(outcome.issueSummary?.join(' ')).toContain('dispatch_summary');
    }
  });

  it('accepts a summary of exactly 800 characters', () => {
    const record = goodRecord();
    record.dispatch_summary = 'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH);
    expect(parseOf(record).ok).toBe(true);
  });
});

describe('issueSummary privacy', () => {
  it('carries zod path + code only, never the received value', () => {
    const record = goodRecord();
    record.location_on_property = 'SECRET-LEAKED-VALUE';
    record.scope_signal = 'not_a_scope';
    const outcome = parseOf(record);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const joined = (outcome.issueSummary ?? []).join(' ');
      expect(joined).not.toContain('SECRET-LEAKED-VALUE');
      expect(joined).not.toContain('not_a_scope');
      expect(joined).toContain('scope_signal');
    }
  });
});
