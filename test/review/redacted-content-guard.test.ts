import { describe, expect, it } from 'vitest';
import { guardRedactedContent } from '../../src/review/redacted-content-guard.js';
import { serializeReviewDetail } from '../../src/review/serialize.js';

describe('guardRedactedContent (Task 6.2)', () => {
  it('passes clean redacted text (tokens only)', () => {
    const res = guardRedactedContent('Customer [NAME_1] called about a leak near [ADDRESS_1].', []);
    expect(res.safe).toBe(true);
    expect(res.categories).toEqual([]);
  });

  it('withholds text containing a residual phone-like digit run', () => {
    const res = guardRedactedContent('call me back at 5551234567 tomorrow', []);
    expect(res.safe).toBe(false);
    expect(res.categories.length).toBeGreaterThan(0);
  });

  it('withholds text containing an email-like shape', () => {
    const res = guardRedactedContent('reach me at john at example dot com', []);
    expect(res.safe).toBe(false);
  });

  it('withholds a deny-list term that survived', () => {
    const res = guardRedactedContent('the customer is Bibbleton Plumbing', ['Bibbleton']);
    expect(res.safe).toBe(false);
  });
});

describe('serializeReviewDetail no-egress backstop', () => {
  it('throws if a known content field name is smuggled into the DTO', () => {
    const dto = {
      id: 'r1',
      call_id: 'c1',
      held_reason: 'redaction_failed',
      explanation: 'x',
      status: 'open',
      assignee: null,
      sla_due_at: null,
      sla_state: 'ok',
      escalated: false,
      raw_purged: false,
      created_at: '2026-07-03T00:00:00.000Z',
      resolved_at: null,
      raw_available: false,
      redacted_content_available: false,
      redacted_content: null,
      redacted_content_withheld_reason: 'no_clean_transcript',
      extracted: null,
      allowed_actions: ['reject'],
      // Smuggled raw content key — must fail loudly.
      transcript: 'raw call text',
    } as never;
    expect(() => serializeReviewDetail(dto)).toThrow();
  });
});
