import { describe, expect, it } from 'vitest';
import { deriveOutcome, outcomeWhereClause, OUTCOME_FILTERS } from '../../src/status/calls.js';
import { renderCallsPage } from '../../src/status/calls-render.js';
import type { CallsPage } from '../../src/status/calls.js';

const samplePage: CallsPage = {
  items: [
    {
      call_id: 'call-1',
      status: 'skipped',
      current_stage: 'metadata-pre-filter',
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:01:00.000Z',
      outcome: deriveOutcome('skipped', 'classified_non_customer', null),
    },
  ],
  page: 1,
  page_size: 50,
  total: 1,
  total_pages: 1,
  filter: 'non_customer',
};

describe('deriveOutcome — call_state.status + drop_reason + held_reason → human outcome', () => {
  it('maps a completed call to Customer', () => {
    expect(deriveOutcome('completed', null, null)).toEqual({
      key: 'customer_completed',
      label: 'Customer',
      reason: null,
    });
  });

  it('maps skipped + classified_non_customer to Non-customer', () => {
    expect(deriveOutcome('skipped', 'classified_non_customer', null)).toEqual({
      key: 'non_customer',
      label: 'Non-customer',
      reason: null,
    });
  });

  it('maps other skips to Filtered with a humanized reason', () => {
    expect(deriveOutcome('skipped', 'zero_duration', null)).toEqual({
      key: 'filtered',
      label: 'Filtered',
      reason: 'Zero duration',
    });
  });

  it('maps held + classified_spam to Spam', () => {
    expect(deriveOutcome('held', null, 'classified_spam')).toEqual({
      key: 'spam',
      label: 'Spam',
      reason: null,
    });
  });

  it('maps other holds to Held with a humanized reason', () => {
    expect(deriveOutcome('held', null, 'redaction_failed')).toEqual({
      key: 'held',
      label: 'Held',
      reason: 'Redaction failed',
    });
  });

  it('maps processing and review_closed', () => {
    expect(deriveOutcome('processing', null, null).key).toBe('processing');
    expect(deriveOutcome('review_closed', null, 'classifier_uncertain')).toEqual({
      key: 'review_closed',
      label: 'Review closed',
      reason: 'Classifier uncertain',
    });
  });

  it('never throws on an unknown status', () => {
    expect(deriveOutcome('something_new', null, null).key).toBe('processing');
  });
});

describe('outcomeWhereClause — filter key → safe SQL predicate (fixed enum literals only)', () => {
  it('returns null for all/undefined (no filter)', () => {
    expect(outcomeWhereClause(undefined)).toBeNull();
    expect(outcomeWhereClause('all')).toBeNull();
  });

  it('builds a non-customer predicate', () => {
    expect(outcomeWhereClause('non_customer')).toBe(
      "cs.status = 'skipped' AND cs.drop_reason = 'classified_non_customer'",
    );
  });

  it('builds a spam predicate off the joined held_reason', () => {
    expect(outcomeWhereClause('spam')).toBe("rq.held_reason = 'classified_spam'");
  });

  it('ignores an unknown filter key (treats as no filter)', () => {
    expect(outcomeWhereClause('; DROP TABLE call_state; --')).toBeNull();
  });

  it('every filter option except "all" produces a predicate', () => {
    for (const f of OUTCOME_FILTERS) {
      if (f.key === 'all') continue;
      expect(outcomeWhereClause(f.key), f.key).toBeTypeOf('string');
    }
  });
});

describe('renderCallsPage', () => {
  it('renders the outcome badge, the filter dropdown, and the call id', () => {
    const html = renderCallsPage(samplePage);
    expect(html).toContain('Non-customer');
    expect(html).toContain('<select name="outcome">');
    expect(html).toContain('call-1');
    expect(html).toContain('href="/status"'); // nav back to health
  });

  it('never emits a source_metadata field (PII boundary)', () => {
    expect(renderCallsPage(samplePage)).not.toContain('source_metadata');
  });

  it('shows an empty-state row when there are no items', () => {
    const html = renderCallsPage({ ...samplePage, items: [], total: 0 });
    expect(html).toContain('No calls match');
  });
});
