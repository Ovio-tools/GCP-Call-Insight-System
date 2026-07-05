import { describe, expect, it } from 'vitest';
import { slaState } from '../../src/review/sla-state.js';
import { rawRetentionWindowOpen, rawTranscriptRevealAllowed } from '../../src/review/raw-access.js';
import { isElevatedReviewer } from '../../src/review/roles.js';
import { explanationFor, HELD_REASON_EXPLANATIONS } from '../../src/review/explanations.js';
import {
  HUMAN_REVIEW_MODEL_ID,
  HUMAN_REVIEW_PROBLEM_STATEMENT,
  HUMAN_REVIEW_PROMPT_VERSION,
} from '../../src/review/correction-constants.js';
import { HELD_REASON } from '../../src/db/enums.js';
import { makeTestConfig } from '../_config.js';

describe('slaState', () => {
  const now = new Date('2026-07-03T12:00:00Z');
  it('is breached at/after the due time', () => {
    expect(slaState(new Date('2026-07-03T12:00:00Z'), now)).toBe('breached');
    expect(slaState(new Date('2026-07-03T11:59:00Z'), now)).toBe('breached');
  });
  it('is due_soon within one scan cadence (15 min) of due', () => {
    expect(slaState(new Date('2026-07-03T12:10:00Z'), now)).toBe('due_soon');
  });
  it('is ok when comfortably ahead', () => {
    expect(slaState(new Date('2026-07-03T13:00:00Z'), now)).toBe('ok');
  });
  it('treats a null due time as ok', () => {
    expect(slaState(null, now)).toBe('ok');
  });
});

describe('raw-access predicates', () => {
  const config = makeTestConfig({ REVIEW_HELD_RAW_RETENTION_CAP_HOURS: 24 });
  const created = new Date('2026-07-03T00:00:00Z');

  it('window open within the cap and not purged', () => {
    const now = new Date('2026-07-03T10:00:00Z'); // 10h < 24h
    expect(rawRetentionWindowOpen({ raw_purged_at: null, created_at: created }, now, config)).toBe(
      true,
    );
  });
  it('window closed once purged', () => {
    const now = new Date('2026-07-03T10:00:00Z');
    expect(
      rawRetentionWindowOpen({ raw_purged_at: new Date(), created_at: created }, now, config),
    ).toBe(false);
  });
  it('window closed past the cap even when raw_purged_at is still null (lagging cron)', () => {
    const now = new Date('2026-07-04T01:00:00Z'); // 25h > 24h
    expect(rawRetentionWindowOpen({ raw_purged_at: null, created_at: created }, now, config)).toBe(
      false,
    );
  });
  it('reveal-allowed requires BOTH the window and a present transcript', () => {
    const now = new Date('2026-07-03T10:00:00Z');
    const review = { raw_purged_at: null, created_at: created };
    expect(rawTranscriptRevealAllowed(review, now, config, true)).toBe(true);
    expect(rawTranscriptRevealAllowed(review, now, config, false)).toBe(false);
    // Past cap: never, even with a transcript present.
    const late = new Date('2026-07-04T01:00:00Z');
    expect(rawTranscriptRevealAllowed(review, late, config, true)).toBe(false);
  });
});

describe('isElevatedReviewer', () => {
  it('is false when the role is unset (fail-closed)', () => {
    const config = makeTestConfig();
    expect(isElevatedReviewer({ id: 'u', roles: ['review_elevated'] }, config)).toBe(false);
  });
  it('is true only when the session carries the configured role', () => {
    const config = makeTestConfig({ REVIEW_ELEVATED_ROLE: 'review_elevated' });
    expect(isElevatedReviewer({ id: 'u', roles: ['review_elevated'] }, config)).toBe(true);
    expect(isElevatedReviewer({ id: 'u', roles: ['reviewer'] }, config)).toBe(false);
    expect(isElevatedReviewer(undefined, config)).toBe(false);
  });
});

describe('explanations + correction constants', () => {
  it('has an explanation for every held_reason', () => {
    for (const reason of HELD_REASON) {
      expect(explanationFor(reason).length).toBeGreaterThan(0);
      expect(HELD_REASON_EXPLANATIONS[reason]).toBeDefined();
    }
  });
  it('pins the human-review provenance constants', () => {
    expect(HUMAN_REVIEW_PROBLEM_STATEMENT).toBe('Human-reviewed extraction correction');
    expect(HUMAN_REVIEW_PROMPT_VERSION).toBe('human-review-correction-v1');
    expect(HUMAN_REVIEW_MODEL_ID).toBe('human-review');
  });
});
