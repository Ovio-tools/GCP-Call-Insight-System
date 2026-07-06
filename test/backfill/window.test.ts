import { describe, expect, it } from 'vitest';
import type { RecentCall } from '../../src/dialpad/client/index.js';
import { callMembership, computeSince } from '../../src/backfill/window.js';

const FROM = Date.parse('2021-01-10T00:00:00Z');
const TO = Date.parse('2021-01-11T00:00:00Z');
const BOUNDS = { fromMs: FROM, toMs: TO };

function call(over: Partial<RecentCall>): RecentCall {
  return { callId: 'c', startedAt: FROM, ...over };
}

describe('computeSince', () => {
  it('reaches back from - maxCallMinutes (Dialpad lists by START time)', () => {
    expect(computeSince(FROM, 240)).toBe(FROM - 240 * 60_000);
  });
});

describe('callMembership — conclusion-time window (§2)', () => {
  it('includes a call that started before `from` but ended inside the window', () => {
    expect(callMembership(call({ startedAt: FROM - 60_000, endedAt: FROM + 60_000 }), BOUNDS)).toBe(
      'include',
    );
  });

  it('excludes a call that ended after `to`', () => {
    expect(callMembership(call({ startedAt: FROM, endedAt: TO + 60_000 }), BOUNDS)).toBe('skip');
  });

  it('excludes a call that ended before `from`', () => {
    expect(
      callMembership(call({ startedAt: FROM - 120_000, endedAt: FROM - 60_000 }), BOUNDS),
    ).toBe('skip');
  });

  it('includes a call with NO endedAt when startedAt <= to (bounded fail-open, R2 #4)', () => {
    expect(callMembership(call({ startedAt: TO - 60_000 }), BOUNDS)).toBe('include');
  });

  it('excludes a call with NO endedAt when startedAt > to (above-window, R2 #4)', () => {
    expect(callMembership(call({ startedAt: TO + 60_000 }), BOUNDS)).toBe('skip');
  });

  it('skips a recognised active/non-terminal call with no endedAt', () => {
    expect(callMembership(call({ startedAt: FROM, state: 'in_progress' }), BOUNDS)).toBe('skip');
  });
});
