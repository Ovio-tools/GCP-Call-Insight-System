import { describe, expect, it } from 'vitest';
import {
  advanceWatermark,
  decodeCheckpoint,
  encodeCheckpoint,
  pageStartedAtFailure,
  shouldSkip,
  type BackfillCheckpoint,
} from '../../src/backfill/checkpoint.js';
import { BackfillError } from '../../src/backfill/errors.js';

const CP: BackfillCheckpoint = {
  v: 1,
  phase: 'sweep',
  watermarkStartedAtMs: 1_730_000_000_000,
  callsSeen: 1234,
  seededTotal: 87,
  terminalCount: 40,
};

describe('encode/decodeCheckpoint', () => {
  it('round-trips', () => {
    expect(decodeCheckpoint(encodeCheckpoint(CP))).toEqual(CP);
  });

  it('returns undefined for a null (no checkpoint yet)', () => {
    expect(decodeCheckpoint(null)).toBeUndefined();
  });

  it('throws invalid_checkpoint on malformed JSON', () => {
    let caught: unknown;
    try {
      decodeCheckpoint('{not json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackfillError);
    expect((caught as BackfillError).reason).toBe('invalid_checkpoint');
  });

  it('throws invalid_checkpoint on a wrong-shaped object', () => {
    expect(() => decodeCheckpoint('{"v":1,"phase":"nope"}')).toThrow(BackfillError);
  });
});

describe('shouldSkip (strict >, boundary re-ingested)', () => {
  it('skips calls strictly newer than the watermark', () => {
    expect(shouldSkip(1_730_000_000_001, 1_730_000_000_000)).toBe(true);
  });
  it('RE-INGESTS a call exactly at the watermark (idempotent, no gap)', () => {
    expect(shouldSkip(1_730_000_000_000, 1_730_000_000_000)).toBe(false);
  });
  it('processes calls older than the watermark', () => {
    expect(shouldSkip(1_729_999_999_999, 1_730_000_000_000)).toBe(false);
  });
});

describe('advanceWatermark (moves down to a page oldest)', () => {
  it('takes the page min when no prior watermark', () => {
    expect(advanceWatermark(undefined, [500, 300, 400])).toBe(300);
  });
  it('never moves the watermark up (min of prior + page)', () => {
    expect(advanceWatermark(200, [500, 300, 400])).toBe(200);
    expect(advanceWatermark(600, [500, 300, 400])).toBe(300);
  });
});

describe('pageStartedAtFailure (fail-closed, R2 #3)', () => {
  it('returns undefined when every item has a parseable startedAt', () => {
    expect(
      pageStartedAtFailure([
        { callId: 'a', startedAt: 1 },
        { callId: 'b', startedAt: 2 },
      ]),
    ).toBeUndefined();
  });
  it('returns the offending call id when one item lacks startedAt', () => {
    expect(pageStartedAtFailure([{ callId: 'a', startedAt: 1 }, { callId: 'bad' }])).toBe('bad');
  });
});
