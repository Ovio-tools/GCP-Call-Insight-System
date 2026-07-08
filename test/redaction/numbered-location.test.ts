import { describe, expect, it } from 'vitest';
import { numberedLocationPrefix } from '../../src/redaction/ner-detector.js';

/**
 * Unit tests (no model) for the numbered-LOC adjacency rule (ADR 0006): a NER
 * location span is redacted only when a house-style number (1-6 digits)
 * immediately precedes it, separated by horizontal whitespace only. The helper
 * returns the widened span start (covering the number) or null.
 */

/** Span start of `word` inside `text`. */
function startOf(text: string, word: string): number {
  const at = text.indexOf(word);
  if (at === -1) throw new Error(`fixture bug: ${word} not in ${text}`);
  return at;
}

describe('numberedLocationPrefix', () => {
  it('fires on a house number directly before the span and returns the widened start', () => {
    const text = 'I live at 4482 Kensington Meadows, the one with the fountain';
    const spanStart = startOf(text, 'Kensington');
    expect(numberedLocationPrefix(text, spanStart)).toBe(text.indexOf('4482'));
  });

  it('fires on a 1-digit and a 6-digit number', () => {
    const one = 'meet me at 8 Elmwood tomorrow';
    expect(numberedLocationPrefix(one, startOf(one, 'Elmwood'))).toBe(one.indexOf('8'));
    const six = 'the site is 214500 Ranchline if the gate is open';
    expect(numberedLocationPrefix(six, startOf(six, 'Ranchline'))).toBe(six.indexOf('214500'));
  });

  it('does NOT fire when words sit between the number and the location', () => {
    const text = 'we have 2 units in Roseville that need service';
    expect(numberedLocationPrefix(text, startOf(text, 'Roseville'))).toBeNull();
  });

  it('does NOT fire when there is no number at all', () => {
    const text = 'I am calling from Sacramento about the estimate';
    expect(numberedLocationPrefix(text, startOf(text, 'Sacramento'))).toBeNull();
  });

  it('does NOT fire across a newline', () => {
    const text = 'the count was 42\nSacramento office called back';
    expect(numberedLocationPrefix(text, startOf(text, 'Sacramento'))).toBeNull();
  });

  it('does NOT fire off the tail of a 7+ digit run (phone-shaped numbers)', () => {
    const text = 'call 9165550142 Sacramento branch please';
    expect(numberedLocationPrefix(text, startOf(text, 'Sacramento'))).toBeNull();
  });

  it('does NOT fire at the very start of the text without a number', () => {
    const text = 'Roseville is where the office building is';
    expect(numberedLocationPrefix(text, 0)).toBeNull();
  });

  it('tolerates multiple spaces/tabs between number and location', () => {
    const text = 'it is at 950\t  J Street somewhere';
    expect(numberedLocationPrefix(text, startOf(text, 'J Street'))).toBe(text.indexOf('950'));
  });
});
