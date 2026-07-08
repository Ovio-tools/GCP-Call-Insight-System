import { describe, expect, it } from 'vitest';
import {
  createRegexDetector,
  detectPhones,
  detectEmails,
  detectStreetAddresses,
  detectCrossStreets,
  detectCreditCards,
  detectGovernmentIds,
  detectGreetingNames,
  detectLongNumbers,
  detectSpelledDigits,
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

describe('generic long-number detection', () => {
  it.each([
    ['the account is 1234567 ok', '1234567'],
    ['confirmation 12345678 received', '12345678'],
    ['tracking 12345678901 arrived', '12345678901'],
    ['it reads 43 81 99 2 4 on the tag', '43 81 99 2 4'],
  ])('detects the >=7-digit run in %s as number', (text, expected) => {
    const hits = detectLongNumbers(text);
    expect(hits.length).toBe(1);
    expect(surface(text, hits[0]!)).toBe(expected);
    expect(hits[0]!.entityType).toBe('number');
  });

  it('does not fire under 7 digits', () => {
    expect(detectLongNumbers('order 123456 shipped for 400 dollars')).toHaveLength(0);
  });

  it('is suppressed by the pooled detector when a phone/card/gov-id fully covers the run', async () => {
    for (const text of [
      'call me at (916) 555-1234 today',
      'my social is 123-45-6789 ok',
      'card 4111 1111 1111 1111 expiring',
    ]) {
      const result = await createRegexDetector().detect(text);
      expect(result.detections.some((d) => d.entityType === 'number')).toBe(false);
      expect(result.detections.length).toBeGreaterThan(0);
    }
  });

  it('fires via the pooled detector for an uncovered solid run', async () => {
    const text = 'the invoice number was 12345678 from last spring';
    const result = await createRegexDetector().detect(text);
    const numbers = result.detections.filter((d) => d.entityType === 'number');
    expect(numbers).toHaveLength(1);
    expect(surface(text, numbers[0]!)).toBe('12345678');
  });
});

describe('spelled-out digit detection', () => {
  it('detects a full spoken phone number as phone', () => {
    const text =
      'The callback number is nine one six five five five zero one four eight, please read that back';
    const hits = detectSpelledDigits(text);
    expect(hits).toHaveLength(1);
    expect(surface(text, hits[0]!)).toBe('nine one six five five five zero one four eight');
    expect(hits[0]!.entityType).toBe('phone');
  });

  it('detects runs with oh and double/triple multipliers', () => {
    const oh = 'It is five five five, oh one, four nine, that is the number';
    expect(detectSpelledDigits(oh).map((h) => surface(oh, h))).toEqual([
      'five five five, oh one, four nine',
    ]);

    const dbl = 'the after hours line is five five five double zero one six four, they pick up';
    expect(detectSpelledDigits(dbl).map((h) => surface(dbl, h))).toEqual([
      'five five five double zero one six four',
    ]);
  });

  it('does not fire on ordinary number talk', () => {
    for (const text of [
      'it never gets below seventy eight degrees in the afternoon',
      'give me ten minutes and a hundred bucks',
      'the code is one two three four', // run of 4
    ]) {
      expect(detectSpelledDigits(text)).toHaveLength(0);
    }
  });

  it('fires via the pooled detector', async () => {
    const text = 'dial nine one six five five five zero one four eight now';
    const result = await createRegexDetector().detect(text);
    const spelled = result.detections.filter((d) => d.entityType === 'phone');
    expect(spelled).toHaveLength(1);
    expect(surface(text, spelled[0]!)).toBe('nine one six five five five zero one four eight');
  });
});

describe('greeting-cue name detection', () => {
  it('detects the capitalized run after strong cues as name (cue not included)', () => {
    for (const [text, expected] of [
      ['Hi, my name is Rosalind Nakamura and my heater is broken', 'Rosalind Nakamura'],
      ['you can ask for Deshawn at the desk', 'Deshawn'],
      ['I was speaking with Tobias Eriksen earlier', 'Tobias Eriksen'],
      ['my name is Jean Claude Van Damme thanks', 'Jean Claude Van Damme'],
    ] as const) {
      const hits = detectGreetingNames(text);
      expect(hits).toHaveLength(1);
      expect(surface(text, hits[0]!)).toBe(expected);
      expect(hits[0]!.entityType).toBe('name');
    }
  });

  it('weak cues require a capitalized bigram', () => {
    const text = 'hello this is David Smith calling about the furnace';
    const hits = detectGreetingNames(text);
    expect(hits).toHaveLength(1);
    expect(surface(text, hits[0]!)).toBe('David Smith');

    expect(detectGreetingNames('this is Bob speaking')).toHaveLength(0);
  });

  it('does not fire on lowercase after the cue', () => {
    for (const text of [
      'this is regarding the invoice from last month',
      'ask for the manager on duty',
      'my name is on the account already',
    ]) {
      expect(detectGreetingNames(text)).toHaveLength(0);
    }
  });

  it('fires via the pooled detector', async () => {
    const text = 'yes my name is Rosalind Nakamura, about the estimate';
    const result = await createRegexDetector().detect(text);
    const names = result.detections.filter((d) => d.entityType === 'name');
    expect(names).toHaveLength(1);
    expect(surface(text, names[0]!)).toBe('Rosalind Nakamura');
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
