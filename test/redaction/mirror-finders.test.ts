import { describe, expect, it } from 'vitest';
import {
  findAddressWindowDigits,
  findDenyTermOccurrences,
  findEmailLike,
  findGreetingNames,
  findLongDigitRuns,
  findSpelledDigitRuns,
  findVaultOccurrences,
} from '../../src/redaction/mirror-finders.js';
import { isVaultValueReintroduced, residualScan } from '../../src/redaction/residual-scan.js';

/**
 * The mirror finders MUST fire whenever the residual scan's corresponding
 * sub-scan would (superset direction) and only where it would (precision
 * neutrality). Each block tests the finder's own offsets; the parity suite at
 * the bottom pins fire/no-fire equivalence against the byte-identical
 * residual scanner itself — the anti-drift tripwire.
 */

const spanText = (text: string, s: { start: number; end: number }): string =>
  text.slice(s.start, s.end);

describe('findLongDigitRuns', () => {
  it('fires on solid 7-, 8-, and 11-digit runs', () => {
    for (const digits of ['1234567', '12345678', '12345678901']) {
      const text = `the number is ${digits} thanks`;
      const runs = findLongDigitRuns(text);
      expect(runs).toHaveLength(1);
      expect(spanText(text, runs[0]!)).toBe(digits);
    }
  });

  it('does not fire on 6 digits', () => {
    expect(findLongDigitRuns('order 123456 confirmed')).toHaveLength(0);
  });

  it('joins digits split by spaces, punctuation, and newlines (letters break the run)', () => {
    const spaced = 'it is 123 45 67 ok';
    const runs = findLongDigitRuns(spaced);
    expect(runs).toHaveLength(1);
    expect(spanText(spaced, runs[0]!)).toBe('123 45 67');

    const punct = 'ref 12-34.56,7 end';
    expect(findLongDigitRuns(punct).map((s) => spanText(punct, s))).toEqual(['12-34.56,7']);

    const newline = 'ref 1234 -\n567 89 more';
    const nl = findLongDigitRuns(newline);
    expect(nl).toHaveLength(1);
    expect(spanText(newline, nl[0]!)).toBe('1234 -\n567 89');

    expect(findLongDigitRuns('123456 Bob 7')).toHaveLength(0);
  });

  it('span covers first to last digit only (no surrounding words)', () => {
    const text = 'account number 9 9 9 9 9 9 9 please';
    const [run] = findLongDigitRuns(text);
    expect(spanText(text, run!)).toBe('9 9 9 9 9 9 9');
  });
});

describe('findSpelledDigitRuns', () => {
  it('fires on the corpus phone-07 and phone-08 shapes', () => {
    const t7 = 'The callback number is nine one six five five five zero one four eight, please';
    const r7 = findSpelledDigitRuns(t7);
    expect(r7).toHaveLength(1);
    expect(spanText(t7, r7[0]!)).toBe('nine one six five five five zero one four eight');

    const t8 = 'It is five five five, oh one, four nine, that is the number';
    const r8 = findSpelledDigitRuns(t8);
    expect(r8).toHaveLength(1);
    expect(spanText(t8, r8[0]!)).toBe('five five five, oh one, four nine');
  });

  it('counts double/triple as multipliers and includes them in the span', () => {
    const text = 'line is five five five double zero one six four thanks';
    const runs = findSpelledDigitRuns(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('five five five double zero one six four');
  });

  it('starts the span at a leading multiplier', () => {
    const text = 'dial double five five one two three four now';
    const runs = findSpelledDigitRuns(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('double five five one two three four');
  });

  it('does not fire on ordinary number talk', () => {
    for (const text of [
      'it never gets below seventy eight degrees in there',
      'give me ten minutes',
      'a hundred bucks',
      'that costs one two three dollars', // run of 3
      'oh okay, one moment', // oh + one separated
      'a double bogey on seven', // lone multiplier
    ]) {
      expect(findSpelledDigitRuns(text)).toHaveLength(0);
    }
  });
});

describe('findGreetingNames', () => {
  it('captures the name after a strong cue (span excludes the cue)', () => {
    const text = 'Hi, my name is Rosalind Nakamura and my heater is broken';
    const runs = findGreetingNames(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('Rosalind Nakamura');
  });

  it('captures a single capitalized token after strong cues', () => {
    for (const cue of ['ask for', 'speaking with', 'my name is']) {
      const text = `you can ${cue} Deshawn at the desk`;
      const runs = findGreetingNames(text);
      expect(runs).toHaveLength(1);
      expect(spanText(text, runs[0]!)).toBe('Deshawn');
    }
  });

  it('is greedy across long capitalized runs (4+ tokens)', () => {
    const text = 'my name is Jean Claude Van Damme thanks';
    const runs = findGreetingNames(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('Jean Claude Van Damme');
  });

  it('weak cues require a capitalized bigram and capture greedily', () => {
    const bigram = 'hello this is David Smith calling';
    const b = findGreetingNames(bigram);
    expect(b).toHaveLength(1);
    expect(spanText(bigram, b[0]!)).toBe('David Smith');

    const long = "it's Wanda Okafor Brown here";
    const l = findGreetingNames(long);
    expect(l).toHaveLength(1);
    expect(spanText(long, l[0]!)).toBe('Wanda Okafor Brown');

    expect(findGreetingNames('this is Bob speaking')).toHaveLength(0);
  });

  it('does not fire on lowercase after the cue', () => {
    for (const text of [
      'this is regarding the invoice from last month',
      'ask for the manager on duty',
      'my name is on the account already',
      "it's about the water heater",
    ]) {
      expect(findGreetingNames(text)).toHaveLength(0);
    }
  });

  it('stops the capture at punctuation', () => {
    const text = 'my name is Priya. Ramanathan is the last name';
    const runs = findGreetingNames(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('Priya');
  });
});

describe('findEmailLike', () => {
  it('fires on unicode confusable at-signs', () => {
    const text = 'send it to accounts＠example.com please';
    const runs = findEmailLike(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toContain('＠');
  });

  it('fires on the mixed spoken form (spoken at, literal dot)', () => {
    const text = 'just email john at gmail.com any time';
    const runs = findEmailLike(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('john at gmail.com');
  });

  it('fires on the fully spoken form', () => {
    const text = 'reach me on mike at yahoo dot com after five';
    expect(findEmailLike(text).length).toBeGreaterThan(0);
  });

  it('does not fire on ordinary at/dot prose', () => {
    for (const text of [
      'we will be at the house at noon',
      'meet me at the corner store',
      'the dot on the map is wrong',
    ]) {
      expect(findEmailLike(text)).toHaveLength(0);
    }
  });
});

describe('findDenyTermOccurrences', () => {
  it('matches embedded and letter-split occurrences (aggressive collapse)', () => {
    const embedded = 'the AcmePlumbingSupply account is overdue';
    const e = findDenyTermOccurrences(embedded, ['Acme Plumbing']);
    expect(e).toHaveLength(1);
    expect(spanText(embedded, e[0]!)).toBe('AcmePlumbing');

    const dashed = 'Look under A-c-m-e P-l-u-m-b-i-n-g, the intake system put dashes in';
    const d = findDenyTermOccurrences(dashed, ['Acme Plumbing']);
    expect(d).toHaveLength(1);
    expect(spanText(dashed, d[0]!)).toBe('A-c-m-e P-l-u-m-b-i-n-g');
  });

  it('ignores terms under 3 normalized chars and non-occurrences', () => {
    expect(findDenyTermOccurrences('ab was here', ['a b'])).toHaveLength(0);
    expect(findDenyTermOccurrences('nothing to see', ['Acme Plumbing'])).toHaveLength(0);
  });
});

describe('findVaultOccurrences', () => {
  it('finds punctuation-split long values (collapsed match)', () => {
    const text = 'yes speak to Mister David? Rolando. He called before';
    const runs = findVaultOccurrences(text, 'David Rolando');
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('David? Rolando');
  });

  it('finds letter-split long values', () => {
    const text = 'spelled j-o-h-n s-m-i-t-h on the form';
    const runs = findVaultOccurrences(text, 'John Smith');
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('j-o-h-n s-m-i-t-h');
  });

  it('matches short values only on word boundaries', () => {
    const standalone = 'is David there today';
    expect(findVaultOccurrences(standalone, 'David')).toHaveLength(1);

    expect(findVaultOccurrences('I like banana bread', 'Ana')).toHaveLength(0);
  });

  it('never matches values under 3 normalized chars', () => {
    expect(findVaultOccurrences('I did I will I am', 'I')).toHaveLength(0);
    expect(findVaultOccurrences('an an an', 'an')).toHaveLength(0);
  });
});

describe('findAddressWindowDigits', () => {
  it('returns the digit runs near an address keyword', () => {
    const text = 'the zip code is 95814 for that property';
    const runs = findAddressWindowDigits(text);
    expect(runs).toHaveLength(1);
    expect(spanText(text, runs[0]!)).toBe('95814');
  });

  it('covers each digit run in the window', () => {
    const text = 'apartment 4, floor 2, ring twice';
    const spans = findAddressWindowDigits(text).map((s) => spanText(text, s));
    expect(spans).toEqual(['4', '2']);
  });

  it('does not fire without a digit in the 40-char window', () => {
    expect(findAddressWindowDigits('the street sweeper never comes anymore')).toHaveLength(0);
    const farAway = `the street is fine ${'x'.repeat(45)} 12345`;
    expect(findAddressWindowDigits(farAway)).toHaveLength(0);
  });

  it('does not fire on non-keyword words near digits', () => {
    expect(
      findAddressWindowDigits('the unit is 12 years old and the drive is 45 minutes'),
    ).toHaveLength(0);
  });
});

/**
 * Parity against the REAL residual scanner (fire/no-fire, both directions).
 * If residual-scan.ts ever drifts from these mirrors, this suite fails.
 */
describe('mirror/residual parity', () => {
  const categoryOf = (text: string): Record<string, number> =>
    residualScan({ redactedText: text, vaultPlaintexts: [], denyTerms: [] }).counts;

  const CASES: {
    text: string;
    finder: (t: string) => { start: number; end: number }[];
    category: string;
  }[] = [
    // digit_run
    { text: 'ref 1234567 end', finder: findLongDigitRuns, category: 'digit_run' },
    { text: 'ref 12 34 56 7 end', finder: findLongDigitRuns, category: 'digit_run' },
    { text: 'ref 123456 end', finder: findLongDigitRuns, category: 'digit_run' },
    { text: 'ref 123456 and 7 end', finder: findLongDigitRuns, category: 'digit_run' },
    { text: 'line1 123\nline2 4567', finder: findLongDigitRuns, category: 'digit_run' },
    // spelled_out_digits
    {
      text: 'nine one six five five five zero one four eight',
      finder: findSpelledDigitRuns,
      category: 'spelled_out_digits',
    },
    {
      text: 'five five five double zero one six four',
      finder: findSpelledDigitRuns,
      category: 'spelled_out_digits',
    },
    {
      text: 'seventy eight degrees today',
      finder: findSpelledDigitRuns,
      category: 'spelled_out_digits',
    },
    {
      text: 'one two three four five six',
      finder: findSpelledDigitRuns,
      category: 'spelled_out_digits',
    },
    {
      text: 'triple five one two three four',
      finder: findSpelledDigitRuns,
      category: 'spelled_out_digits',
    },
    // name_like_after_greeting
    {
      text: 'my name is Rosalind Nakamura',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'ask for Deshawn at the desk',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'this is David Smith calling',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'this is Bob speaking',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'this is regarding the invoice',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'ask for the manager on duty',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: "it's Wanda Okafor here",
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    {
      text: 'speaking with Priya today',
      finder: findGreetingNames,
      category: 'name_like_after_greeting',
    },
    // email_like
    { text: 'send to accounts＠example.com now', finder: findEmailLike, category: 'email_like' },
    { text: 'email john at gmail.com today', finder: findEmailLike, category: 'email_like' },
    { text: 'mike at yahoo dot com works', finder: findEmailLike, category: 'email_like' },
    { text: 'we will be at the house at noon', finder: findEmailLike, category: 'email_like' },
    { text: 'meet me at the corner store', finder: findEmailLike, category: 'email_like' },
    // address_like
    {
      text: 'the zip code is 95814 there',
      finder: findAddressWindowDigits,
      category: 'address_like',
    },
    { text: 'apartment 4 on the left', finder: findAddressWindowDigits, category: 'address_like' },
    {
      text: 'the street sweeper never comes',
      finder: findAddressWindowDigits,
      category: 'address_like',
    },
    { text: 'the unit is 12 years old', finder: findAddressWindowDigits, category: 'address_like' },
    {
      text: 'my suite has a leak in it',
      finder: findAddressWindowDigits,
      category: 'address_like',
    },
  ];

  it.each(CASES)('$category parity: "$text"', ({ text, finder, category }) => {
    const residualFires = category in categoryOf(text);
    const mirrorFires = finder(text).length > 0;
    expect(mirrorFires).toBe(residualFires);
  });

  it('deny-term parity', () => {
    const terms = ['Acme Plumbing'];
    for (const text of [
      'the AcmePlumbingSupply account',
      'A-c-m-e P-l-u-m-b-i-n-g on file',
      'nothing relevant here',
    ]) {
      const residualFires =
        'deny_list_term' in
        residualScan({ redactedText: text, vaultPlaintexts: [], denyTerms: terms }).counts;
      expect(findDenyTermOccurrences(text, terms).length > 0).toBe(residualFires);
    }
  });

  it('vault parity via the exported predicate', () => {
    const cases: [string, string][] = [
      ['speak to Mister David? Rolando. please', 'David Rolando'],
      ['is David there', 'David'],
      ['I like banana bread', 'Ana'],
      ['I did it myself', 'I'],
      ['j-o-h-n s-m-i-t-h on the form', 'John Smith'],
      ['nothing here at all', 'David Rolando'],
    ];
    for (const [text, value] of cases) {
      expect(findVaultOccurrences(text, value).length > 0).toBe(
        isVaultValueReintroduced(value, text),
      );
    }
  });
});
