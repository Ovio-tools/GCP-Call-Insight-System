import { describe, expect, it } from 'vitest';
import { renderReviewDetailPage, renderReviewListPage } from '../../src/review/render.js';
import type { ReviewDetail, ReviewListItem } from '../../src/review/dto.js';

/**
 * Pure unit tests over the review renderers. No database and no HTTP.
 *
 * These exist because the JSON route tests cannot see the templates: `call_duration_ms` can be
 * present in every API response while the `call length …` fragment has been deleted from the page
 * a reviewer actually reads. Assertions therefore pin the fragment WITH its neighbours, so a
 * deleted or relocated fragment fails rather than being satisfied by the string existing anywhere.
 * The list is rendered with ONE item for the same reason — with several rows a whole-page
 * `toContain` can be satisfied by a different row than the one under test.
 */

function item(overrides: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    id: 'rq-1',
    call_id: '6159886818426880',
    call_duration_ms: 222_400,
    held_reason: 'missing_transcript',
    explanation: 'Dialpad has no transcript for this call.',
    status: 'open',
    assignee: null,
    sla_due_at: '2026-07-03T16:00:00.000Z',
    sla_state: 'ok',
    escalated: false,
    raw_purged: false,
    created_at: '2026-07-03T12:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

function detail(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    ...item(),
    raw_available: false,
    redacted_content_available: false,
    redacted_content: null,
    redacted_content_withheld_reason: 'no_clean_transcript',
    extracted: null,
    allowed_actions: ['approve', 'reject'],
    ...overrides,
  };
}

const listOf = (i: ReviewListItem): string =>
  renderReviewListPage({ items: [i], generated_at: '2026-07-03T12:00:00.000Z' });

const detailOf = (d: ReviewDetail): string =>
  renderReviewDetailPage(d, { csrfToken: 'tok', elevated: false, nonce: 'n0nce' });

describe('review list page — call length', () => {
  it('shows the call length beside when the call was held', () => {
    expect(listOf(item())).toContain('· held 2026-07-03T12:00:00.000Z · call length 3 min 42 sec');
  });

  it('reads "unknown" when the length was never recorded, never a fabricated zero', () => {
    const html = listOf(item({ call_duration_ms: null }));
    expect(html).toContain('· call length unknown');
    expect(html).not.toContain('call length 0 sec');
  });

  it('shows the length for every held reason, not just a missing transcript', () => {
    expect(listOf(item({ held_reason: 'redaction_failed', call_duration_ms: 2_000 }))).toContain(
      '· call length 2 sec',
    );
  });

  it('keeps the escalated / raw-purged flags after the length', () => {
    expect(listOf(item({ escalated: true, raw_purged: true }))).toContain(
      '· call length 3 min 42 sec · escalated · raw purged',
    );
  });
});

describe('review detail page — call length', () => {
  it('shows the call length in the meta line, between the status and the assignee', () => {
    expect(detailOf(detail())).toContain(
      '· status open · call length 3 min 42 sec · assignee unassigned',
    );
  });

  it('reads "unknown" when the length was never recorded, never a fabricated zero', () => {
    const html = detailOf(detail({ call_duration_ms: null }));
    expect(html).toContain('· call length unknown ·');
    expect(html).not.toContain('call length 0 sec');
  });

  it('shows the length for every held reason, not just a missing transcript', () => {
    expect(
      detailOf(detail({ held_reason: 'redaction_failed', call_duration_ms: 2_000 })),
    ).toContain('· call length 2 sec ·');
  });
});
