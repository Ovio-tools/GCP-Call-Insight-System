import { describe, expect, it } from 'vitest';
import {
  parseTechnicianNote,
  type TechnicianNoteRecord,
} from '../../src/technician-notes/index.js';
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

  /**
   * Compile-time pin on the record type, not a runtime assertion.
   *
   * The sentinel normalization is built with `z.preprocess`, whose input type is `unknown`. Typed
   * carelessly that widens the inferred field to `any` and silently disarms every type check on a
   * note — in gates.ts, in the generator, and on the review surface — while every runtime test
   * stays green. These lines fail `npm run typecheck` if that happens again.
   */
  it('infers exact field types (no `any` leaking out of the sentinel preprocessors)', () => {
    type IsAny<T> = 0 extends 1 & T ? true : false;
    const noAnyText: IsAny<TechnicianNoteRecord['location_on_property']> = false;
    const noAnyGroupText: IsAny<TechnicianNoteRecord['equipment']['brand']> = false;
    const noAnyFlag: IsAny<TechnicianNoteRecord['water_status']['supply_shut_off']> = false;
    const text: TechnicianNoteRecord['prior_attempts_detail'] = null as string | null;
    const flag: TechnicianNoteRecord['payer_authority']['can_approve_work'] = null as
      boolean | null;
    expect([noAnyText, noAnyGroupText, noAnyFlag, text, flag]).toEqual([
      false,
      false,
      false,
      null,
      null,
    ]);
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

/**
 * The wire encoding the model actually answers in (ADR 0009). "Not established" travels as a
 * VALUE — `""` for text, `"unknown"` for a flag — because the API caps a schema at 16 union-typed
 * parameters and this note has 31 fields that can be unset. These tests pin the one place that
 * translation happens; everything downstream must keep seeing plain nulls.
 */
describe('sentinel normalization (wire → record)', () => {
  it('turns "" into null in group text, standalone text, and dispatch_summary', () => {
    const record = goodRecord();
    record.equipment = {
      type: 'water heater',
      brand: '',
      model: '',
      capacity: '',
      approximate_age: '',
      fuel_type: '',
    };
    record.location_on_property = '';
    record.symptom_verbatim = '';
    record.prior_attempts_detail = '';
    record.access_notes = '';
    record.dispatch_summary = '';

    const outcome = parseOf(record);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.equipment).toEqual({
        type: 'water heater',
        brand: null,
        model: null,
        capacity: null,
        approximate_age: null,
        fuel_type: null,
      });
      expect(outcome.record.location_on_property).toBeNull();
      expect(outcome.record.symptom_verbatim).toBeNull();
      expect(outcome.record.prior_attempts_detail).toBeNull();
      expect(outcome.record.access_notes).toBeNull();
      expect(outcome.record.dispatch_summary).toBeNull();
    }
  });

  it('maps yes/no/unknown to true/false/null across every flag group', () => {
    const record = goodRecord();
    record.water_status = {
      actively_running: 'yes',
      supply_shut_off: 'no',
      shutoff_location_known: 'unknown',
      active_damage: 'yes',
    };
    record.payer_authority = {
      can_approve_work: 'no',
      home_warranty: 'unknown',
      insurance_claim: 'yes',
      third_party_payer: 'unknown',
    };
    record.prior_work = {
      is_repeat_visit: 'yes',
      is_warranty_claim: 'unknown',
      prior_work_by_others: 'no',
    };
    record.commitments_made = {
      price_quoted: 'no',
      dispatch_fee_mentioned: 'yes',
      arrival_window_given: 'unknown',
      technician_named: 'no',
      scope_described: 'yes',
    };

    const outcome = parseOf(record);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.water_status).toEqual({
        actively_running: true,
        supply_shut_off: false,
        shutoff_location_known: null,
        active_damage: true,
      });
      expect(outcome.record.payer_authority).toEqual({
        can_approve_work: false,
        home_warranty: null,
        insurance_claim: true,
        third_party_payer: null,
      });
      expect(outcome.record.prior_work).toEqual({
        is_repeat_visit: true,
        is_warranty_claim: null,
        prior_work_by_others: false,
      });
      expect(outcome.record.commitments_made).toEqual({
        price_quoted: false,
        dispatch_fee_mentioned: true,
        arrival_window_given: null,
        technician_named: false,
        scope_described: true,
      });
    }
  });

  // "unknown" must mean unset and NOTHING else may sneak through the same door — a flag that
  // accepted arbitrary strings would put free text into a column chosen to be incapable of it.
  it('rejects any other string in a flag field', () => {
    for (const value of ['maybe', 'true', 'YES', 'null', '']) {
      const record = goodRecord();
      record.water_status = {
        actively_running: value,
        supply_shut_off: 'unknown',
        shutoff_location_known: 'unknown',
        active_damage: 'unknown',
      };
      const outcome = parseOf(record);
      expect(outcome.ok, `flag accepted ${JSON.stringify(value)}`).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toBe('schema_invalid');
    }
  });

  it('still enforces the dispatch_summary cap on a non-sentinel value', () => {
    const record = goodRecord();
    record.dispatch_summary = 'x'.repeat(DISPATCH_SUMMARY_MAX_LENGTH + 1);
    const outcome = parseOf(record);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('schema_invalid');
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
