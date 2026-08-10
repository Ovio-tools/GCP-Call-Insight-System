import { describe, expect, it, vi } from 'vitest';
import {
  callDurationMsFromMetadata,
  getCallDurationsMs,
} from '../../src/db/repositories/call-state-repo.js';
import type { Queryable } from '../../src/db/types.js';

/**
 * `call_state.source_metadata` is free-form jsonb that can carry raw call metadata, which is why
 * the per-call status view refuses to read it at all (see the PII note in `src/status/calls.ts`).
 * The duration reader is the ONE narrow exception: a single-key numeric projection. These tests
 * pin that narrowness — no live database needed (`call-state-repo.ts` imports `pg` type-only, and
 * the batched reader takes a `Queryable`, so a hand fake stands in for the pool).
 */

/** A fake pool that records the queries it was handed and replays canned rows. */
function fakeDb(rows: readonly Record<string, unknown>[]): Queryable & {
  calls: { text: string; params: readonly unknown[] }[];
} {
  const calls: { text: string; params: readonly unknown[] }[] = [];
  return {
    calls,
    query: vi.fn((text: string, params?: readonly unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return Promise.resolve({ rows: [...rows] });
    }) as unknown as Queryable['query'],
  };
}

describe('callDurationMsFromMetadata', () => {
  it.each([
    // A finite, non-negative number is the ONLY accepted shape.
    [222_400, 222_400],
    [0, 0],
    [1234.5, 1234.5],
    // Everything else is unknown rather than an error — a drifted or hostile metadata value must
    // not 500 the review queue, and must never reach a DTO in its original form.
    [null, null],
    [undefined, null],
    ['222400', null],
    [-1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [true, null],
    [{ duration: 5 }, null],
    [[5], null],
  ])('%s projects to %s', (input, expected) => {
    expect(callDurationMsFromMetadata(input)).toBe(expected);
  });
});

describe('getCallDurationsMs', () => {
  it('reads every call in ONE query, keyed by call id', async () => {
    const db = fakeDb([
      { call_id: 'a', duration: 222_400 },
      { call_id: 'b', duration: 1_500 },
    ]);

    const map = await getCallDurationsMs(db, ['a', 'b']);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.params).toEqual([['a', 'b']]);
    expect(map.get('a')).toBe(222_400);
    expect(map.get('b')).toBe(1_500);
  });

  it('selects only the single duration key, never source_metadata itself', async () => {
    const db = fakeDb([]);

    await getCallDurationsMs(db, ['a']);

    const text = db.calls[0]?.text ?? '';
    expect(text).toContain("source_metadata -> 'duration'");
    // The whole-object forms. If either ever appears here, the metadata object is being pulled
    // into the process and the de-identification argument for this reader is gone.
    expect(text).not.toContain('SELECT *');
    expect(text).not.toMatch(/source_metadata(?!\s*->)/);
  });

  it('omits calls whose duration is absent or unusable, so callers see "unknown"', async () => {
    const db = fakeDb([
      { call_id: 'known', duration: 2_000 },
      { call_id: 'absent', duration: null },
      { call_id: 'garbage', duration: 'oops' },
    ]);

    const map = await getCallDurationsMs(db, ['known', 'absent', 'garbage']);

    expect(map.get('known')).toBe(2_000);
    expect(map.has('absent')).toBe(false);
    expect(map.has('garbage')).toBe(false);
  });

  it('does not query at all for an empty batch', async () => {
    const db = fakeDb([]);

    const map = await getCallDurationsMs(db, []);

    expect(db.calls).toHaveLength(0);
    expect(map.size).toBe(0);
  });
});
