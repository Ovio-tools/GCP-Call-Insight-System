import { describe, expect, it } from 'vitest';
import {
  createRegexDetector,
  detectPhones,
  detectEmails,
  detectStreetAddresses,
  detectCrossStreets,
  detectCreditCards,
  detectGovernmentIds,
  luhnValid,
} from '../../src/redaction/regex-detectors.js';
import type { Detection } from '../../src/redaction/types.js';

/** The exact source text a detection covers. */
function surface(text: string, d: Detection): string {
  return text.slice(d.start, d.end);
}

describe('phone detection', () => {
  it.each([
    ['call me at (916) 555-1234 today', '(916) 555-1234'],
    ['call 916-555-1234 anytime', '916-555-1234'],
    ['reach me on 916.555.1234 ok', '916.555.1234'],
    ['+1 916 555 1234 is my cell', '+1 916 555 1234'],
    ['my number is 9165551234', '9165551234'],
  ])('detects %s', (text, expected) => {
    const hits = detectPhones(text);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(surface(text, hits[0]!)).toBe(expected);
    expect(hits[0]!.entityType).toBe('phone');
  });

  it('detects digit-by-digit spoken numbers ("5 5 5, 1 2 3 4")', () => {
    const text = 'the number is 5 5 5, 1 2 3 4 thanks';
    const hits = detectPhones(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toContain('5 5 5, 1 2 3 4');
  });

  it('does not flag short numeric runs like order numbers', () => {
    expect(detectPhones('your order 123456 shipped')).toHaveLength(0);
    expect(detectPhones('the quote was 400 dollars')).toHaveLength(0);
  });
});

describe('email detection', () => {
  it.each([
    ['write john.smith@example.com now', 'john.smith@example.com'],
    ['it is john dot smith at gmail dot com ok', 'john dot smith at gmail dot com'],
    ['use john (at) example (dot) com', 'john (at) example (dot) com'],
    ['or john [at] example [dot] com', 'john [at] example [dot] com'],
  ])('detects %s', (text, expected) => {
    const hits = detectEmails(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe(expected);
    expect(hits[0]!.entityType).toBe('email');
  });

  it('does not flag ordinary "at"/"dot" prose', () => {
    expect(detectEmails('meet me at the shop dot your i')).toHaveLength(0);
  });
});

describe('street address detection', () => {
  it.each([
    ['I live at 123 Main Street in town', '123 Main Street'],
    ['4567 W 5th Ave Apt 2B is the unit', '4567 W 5th Ave Apt 2B'],
    ['head to 88 elm st. thanks', '88 elm st.'],
    ['21500 Old Ranch Rd, the gate code', '21500 Old Ranch Rd'],
  ])('detects %s', (text, expected) => {
    const hits = detectStreetAddresses(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe(expected);
    expect(hits[0]!.entityType).toBe('street_address');
  });

  it('does not flag bare numbers followed by ordinary words', () => {
    expect(detectStreetAddresses('we need 3 new filters for the unit')).toHaveLength(0);
  });
});

describe('cross-street detection', () => {
  it.each([
    ['we are at Main and 5th Street', 'Main and 5th Street'],
    ['the corner of Elm Street and Oak', 'Elm Street and Oak'],
    ['between Folsom Blvd and Watt Avenue please', 'Folsom Blvd and Watt Avenue'],
  ])('detects %s', (text, expected) => {
    const hits = detectCrossStreets(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe(expected);
    expect(hits[0]!.entityType).toBe('cross_street');
  });

  it('requires at least one street suffix ("Bob and Alice" is not a cross-street)', () => {
    expect(detectCrossStreets('Bob and Alice will be home')).toHaveLength(0);
  });
});

describe('credit card detection', () => {
  it('detects a Luhn-valid card with separators', () => {
    const text = 'card 4111 1111 1111 1111 expiring soon';
    const hits = detectCreditCards(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe('4111 1111 1111 1111');
    expect(hits[0]!.entityType).toBe('credit_card');
  });

  it('rejects a 16-digit run that fails the Luhn check', () => {
    expect(detectCreditCards('ref 1234 5678 9012 3456 on file')).toHaveLength(0);
  });

  it('exports a correct luhnValid helper', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('1234567890123456')).toBe(false);
  });
});

describe('government id detection', () => {
  it('detects SSN shapes', () => {
    const text = 'my social is 123-45-6789 ok';
    const hits = detectGovernmentIds(text);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(surface(text, hits[0]!)).toBe('123-45-6789');
    expect(hits[0]!.entityType).toBe('government_id');
  });

  it('detects an EIN shape', () => {
    const text = 'the EIN is 12-3456789 for the LLC';
    const hits = detectGovernmentIds(text);
    expect(hits.some((h) => surface(text, h) === '12-3456789')).toBe(true);
  });

  it('detects a contextual license number near a keyword', () => {
    const text = "my driver's license is D1234567 issued here";
    const hits = detectGovernmentIds(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe('D1234567');
  });
});

describe('createRegexDetector', () => {
  it('pools all categories with exact offsets and no risk signals on plain hits', async () => {
    const text = 'John at 123 Main Street, call (916) 555-1234 or j@x.com';
    const result = await createRegexDetector().detect(text);
    const types = result.detections.map((d) => d.entityType).sort();
    expect(types).toEqual(['email', 'phone', 'street_address']);
    for (const d of result.detections) {
      expect(d.detector).toBe('regex');
      expect(d.start).toBeGreaterThanOrEqual(0);
      expect(d.end).toBeGreaterThan(d.start);
      expect(d.end).toBeLessThanOrEqual(text.length);
    }
  });

  it('raises address_like_ambiguous for a number + capitalized words with no suffix', async () => {
    const text = 'the unit is over at 4482 Kensington Meadows if that helps';
    const result = await createRegexDetector().detect(text);
    expect(result.riskSignals.some((s) => s.reason === 'address_like_ambiguous')).toBe(true);
  });

  it('raises no signals on entity-free text', async () => {
    const result = await createRegexDetector().detect('please just fix the water heater soon');
    expect(result.detections).toHaveLength(0);
    expect(result.riskSignals).toHaveLength(0);
  });
});
