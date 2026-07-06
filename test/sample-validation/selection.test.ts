import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SAMPLE_SIZE,
  resolveSampleSelection,
  SampleValidationError,
} from '../../src/sample-validation/index.js';

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SampleValidationError) return err.reason;
    throw err;
  }
  throw new Error('expected a SampleValidationError');
}

describe('resolveSampleSelection', () => {
  it('accepts an explicit call-id list', () => {
    const resolved = resolveSampleSelection({ callIds: ['c1', 'c2'] });
    expect(resolved).toEqual({ mode: 'call_ids', callIds: ['c1', 'c2'] });
  });

  it('accepts a sample size within the cap', () => {
    expect(resolveSampleSelection({ sampleSize: 5 })).toEqual({
      mode: 'sample_size',
      sampleSize: 5,
    });
  });

  it('trims and de-duplicates call ids, preserving order', () => {
    const resolved = resolveSampleSelection({ callIds: [' c1 ', 'c2', 'c1'] });
    expect(resolved).toEqual({ mode: 'call_ids', callIds: ['c1', 'c2'] });
  });

  it('refuses when neither a size nor a list is provided', () => {
    expect(reasonOf(() => resolveSampleSelection({}))).toBe('invalid_sample_selection');
  });

  it('refuses when both a size and a list are provided', () => {
    expect(reasonOf(() => resolveSampleSelection({ callIds: ['c1'], sampleSize: 3 }))).toBe(
      'invalid_sample_selection',
    );
  });

  it('refuses an empty (or all-blank) call-id list', () => {
    expect(reasonOf(() => resolveSampleSelection({ callIds: [] }))).toBe(
      'invalid_sample_selection',
    );
    expect(reasonOf(() => resolveSampleSelection({ callIds: ['  ', ''] }))).toBe(
      'invalid_sample_selection',
    );
  });

  it('refuses a call-id list over the conservative cap', () => {
    const tooMany = Array.from({ length: DEFAULT_MAX_SAMPLE_SIZE + 1 }, (_, i) => `c${i}`);
    expect(reasonOf(() => resolveSampleSelection({ callIds: tooMany }))).toBe(
      'invalid_sample_selection',
    );
  });

  it('refuses a sample size of zero, negative, or non-integer', () => {
    expect(reasonOf(() => resolveSampleSelection({ sampleSize: 0 }))).toBe(
      'invalid_sample_selection',
    );
    expect(reasonOf(() => resolveSampleSelection({ sampleSize: -2 }))).toBe(
      'invalid_sample_selection',
    );
    expect(reasonOf(() => resolveSampleSelection({ sampleSize: 2.5 }))).toBe(
      'invalid_sample_selection',
    );
  });

  it('refuses a sample size over the conservative cap', () => {
    expect(
      reasonOf(() => resolveSampleSelection({ sampleSize: DEFAULT_MAX_SAMPLE_SIZE + 1 })),
    ).toBe('invalid_sample_selection');
  });

  it('honors a lower caller-supplied cap', () => {
    expect(reasonOf(() => resolveSampleSelection({ sampleSize: 4 }, { maxSampleSize: 3 }))).toBe(
      'invalid_sample_selection',
    );
  });
});
