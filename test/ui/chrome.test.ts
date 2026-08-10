import { describe, expect, it } from 'vitest';
import { formatDurationMs } from '../../src/ui/chrome.js';

/**
 * Direct unit tests over the SHARED label helpers in `src/ui/chrome.ts`.
 *
 * `formatDurationMs` renders a call's length for a reviewer deciding whether a held call was ever
 * long enough to be a real conversation — a two-second call with no transcript is closable, a
 * four-minute one is a genuine problem. Two properties are load-bearing and are pinned as a table
 * rather than as spot checks:
 *
 *  1. It FLOORS, never rounds. Under-reporting is the safe direction for that judgement, and
 *     rounding would print a self-contradicting "60 sec" for 59,999 ms.
 *  2. An unknown length reads "unknown", never a fabricated `0 sec`. Null, non-finite, and
 *     negative inputs all collapse there — the fail-safe convention (say "I don't know" rather
 *     than assert a wrong fact).
 */
describe('formatDurationMs', () => {
  it.each([
    // Unknown-length inputs: never fabricate a number.
    [null, 'unknown'],
    [Number.NaN, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
    [-1, 'unknown'],
    // A reported zero-length call is a FACT and reads as one, distinct from "unknown".
    [0, '0 sec'],
    // Sub-second: floor alone would print a misleading "0 sec" for a real call.
    [1, 'under 1 sec'],
    [999, 'under 1 sec'],
    // Seconds.
    [1_000, '1 sec'],
    [2_400, '2 sec'],
    [59_999, '59 sec'],
    // Minutes + seconds.
    [60_000, '1 min 0 sec'],
    [222_400, '3 min 42 sec'],
    [3_599_999, '59 min 59 sec'],
    // Hours: seconds are dropped as noise at this scale.
    [3_600_000, '1 hr 0 min'],
    [5_430_000, '1 hr 30 min'],
  ])('%s ms reads as "%s"', (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });
});
