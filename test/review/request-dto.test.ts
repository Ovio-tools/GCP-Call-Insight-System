import { describe, expect, it } from 'vitest';
import {
  REPROCESS_STAGE_VALUES,
  correctExtractionBodySchema,
  emptyBodySchema,
  reprocessBodySchema,
  reviewActionSchema,
  revealQuerySchema,
  vaultTokenSchema,
} from '../../src/review/request-dto.js';
import { REPROCESS_STAGES } from '../../src/review/action-matrix.js';

describe('review request DTOs (Task 6.2)', () => {
  it('REPROCESS_STAGE_VALUES equals the union of REPROCESS_STAGES (drift guard)', () => {
    const union = [...new Set(Object.values(REPROCESS_STAGES).flat())].sort();
    expect([...REPROCESS_STAGE_VALUES].sort()).toEqual(union);
  });

  it('reviewActionSchema rejects an unknown action (→ handled as REQUEST_MALFORMED)', () => {
    expect(reviewActionSchema.safeParse('reprocess').success).toBe(true);
    expect(reviewActionSchema.safeParse('reveal_raw').success).toBe(false); // reveal is a route, not an action
    expect(reviewActionSchema.safeParse('nope').success).toBe(false);
  });

  it('reprocessBody accepts a valid stage, rejects approve, extra keys, wrong types', () => {
    expect(reprocessBodySchema.safeParse({ stage: 'redact' }).success).toBe(true);
    expect(reprocessBodySchema.safeParse({ stage: 'approve' }).success).toBe(false); // approve is not a stage
    expect(reprocessBodySchema.safeParse({ stage: 'store' }).success).toBe(false); // not a reprocess target
    expect(reprocessBodySchema.safeParse({ stage: 'redact', extra: 1 }).success).toBe(false);
    expect(reprocessBodySchema.safeParse({ stage: 5 }).success).toBe(false);
  });

  it('correctExtractionBody accepts the four enums only, no free text', () => {
    const ok = correctExtractionBodySchema.safeParse({
      call_intent: 'new_booking',
      service_category: 'water_heater',
      urgency: 'routine',
      sentiment: 'neutral',
    });
    expect(ok.success).toBe(true);
    // Any free-text key (problem_statement, customer_language, …) is rejected.
    expect(
      correctExtractionBodySchema.safeParse({
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'routine',
        sentiment: 'neutral',
        problem_statement: 'leaking pipe at 123 Main St',
      }).success,
    ).toBe(false);
    expect(
      correctExtractionBodySchema.safeParse({
        call_intent: 'bogus',
        service_category: 'water_heater',
        urgency: 'routine',
        sentiment: 'neutral',
      }).success,
    ).toBe(false);
  });

  it('terminal actions take an empty strict body', () => {
    expect(emptyBodySchema.safeParse({}).success).toBe(true);
    expect(emptyBodySchema.safeParse({ anything: 1 }).success).toBe(false);
  });

  it('vault token syntax is a bracketed label only', () => {
    expect(vaultTokenSchema.safeParse('[NAME_1]').success).toBe(true);
    expect(vaultTokenSchema.safeParse('[PHONE_3456789]').success).toBe(true);
    expect(vaultTokenSchema.safeParse('NAME_1').success).toBe(false);
    expect(vaultTokenSchema.safeParse('[name_1]').success).toBe(false);
    expect(vaultTokenSchema.safeParse('[NAME_1] OR 1=1').success).toBe(false);
  });

  it('revealQuery allows an optional token, rejects extras', () => {
    expect(revealQuerySchema.safeParse({}).success).toBe(true);
    expect(revealQuerySchema.safeParse({ token: '[NAME_1]' }).success).toBe(true);
    expect(revealQuerySchema.safeParse({ token: '[NAME_1]', x: 1 }).success).toBe(false);
  });
});
