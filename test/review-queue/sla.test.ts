import { describe, expect, it } from 'vitest';
import { HELD_REASON } from '../../src/db/enums.js';
import { slaMinutesFor } from '../../src/review-queue/sla.js';
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
