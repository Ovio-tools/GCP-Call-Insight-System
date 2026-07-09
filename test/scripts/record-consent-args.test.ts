import { describe, expect, it } from 'vitest';
import { ALLOWED_GATE_TYPES, parseRecordConsentArgs } from '../../src/scripts/record-consent.js';

describe('parseRecordConsentArgs', () => {
  const base = [
    '--gate',
    'dialpad_recording_consent',
    '--by',
    'Jane Doe',
    '--note',
    'email 2026-06-30',
  ];

  it('parses a valid full invocation', () => {
    expect(parseRecordConsentArgs(base)).toEqual({
      gateType: 'dialpad_recording_consent',
      recordedBy: 'Jane Doe',
      note: 'email 2026-06-30',
      force: false,
    });
  });

  it('trims whitespace on values', () => {
    expect(
      parseRecordConsentArgs([
        '--gate',
        'signed_services_agreement',
        '--by',
        '  Jane  ',
        '--note',
        '  ref  ',
      ]),
    ).toMatchObject({ recordedBy: 'Jane', note: 'ref' });
  });

  it('parses --force', () => {
    expect(parseRecordConsentArgs([...base, '--force']).force).toBe(true);
  });

  it('rejects an unknown gate type', () => {
    expect(() => parseRecordConsentArgs(['--gate', 'nope', '--by', 'x', '--note', 'y'])).toThrow(
      /--gate must be one of/,
    );
  });

  it('rejects a missing --by', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--note', 'y']),
    ).toThrow(/--by/);
  });

  it('rejects an empty --note', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--by', 'x', '--note', '   ']),
    ).toThrow(/--note/);
  });

  it('treats a following flag as a missing value', () => {
    expect(() =>
      parseRecordConsentArgs(['--gate', 'signed_services_agreement', '--by', '--note', 'y']),
    ).toThrow(/--by/);
  });

  it('accepts every canonical gate type', () => {
    for (const g of ALLOWED_GATE_TYPES) {
      expect(parseRecordConsentArgs(['--gate', g, '--by', 'x', '--note', 'y']).gateType).toBe(g);
    }
  });
});
