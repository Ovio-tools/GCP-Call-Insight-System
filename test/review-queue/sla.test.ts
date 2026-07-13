import { describe, expect, it } from 'vitest';
import { HELD_REASON } from '../../src/db/enums.js';
import { reviewStalledDedupKey, slaMinutesFor } from '../../src/review-queue/sla.js';
import { DEFAULT_REVIEW_SLA_MINUTES_BY_REASON, makeTestConfig } from '../_config.js';

describe('slaMinutesFor', () => {
  const config = makeTestConfig();

  it('returns the configured minutes for every held_reason (totality)', () => {
    for (const reason of HELD_REASON) {
      expect(slaMinutesFor(config, reason)).toBe(DEFAULT_REVIEW_SLA_MINUTES_BY_REASON[reason]);
    }
  });

  it('resolves emergency_review to the strict minimum across all reasons', () => {
    const emergency = slaMinutesFor(config, 'emergency_review');
    for (const reason of HELD_REASON) {
      if (reason === 'emergency_review') continue;
      expect(slaMinutesFor(config, reason)).toBeGreaterThan(emergency);
    }
  });
});

describe('reviewStalledDedupKey', () => {
  it('is item-scoped and matches the scan-emit format exactly', () => {
    // This literal is the contract the stalled-scan RAISES under and the resolution ACKNOWLEDGES —
    // if it ever drifts, resolving a call would stop clearing its banner. Pin it here.
    expect(reviewStalledDedupKey('abc-123')).toBe('REVIEW_QUEUE_STALLED:review_queue:abc-123');
  });
});
