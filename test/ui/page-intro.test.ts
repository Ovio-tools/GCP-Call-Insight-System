import { describe, expect, it } from 'vitest';
import { pageIntro, THEME } from '../../src/ui/chrome.js';
import { renderHome } from '../../src/console/home-render.js';
import { renderStatusPage } from '../../src/status/render.js';
import { renderCallsPage } from '../../src/status/calls-render.js';
import { renderKnowledgePage } from '../../src/knowledge/render.js';
import { renderReviewListPage, renderReviewDetailPage } from '../../src/review/render.js';
import { makeStatusDto } from '../status/_fixture.js';
import type { CallsPage } from '../../src/status/calls.js';
import type { KnowledgeView } from '../../src/knowledge/dto.js';
import type { ReviewDetail, ReviewList } from '../../src/review/dto.js';

/**
 * Every screen must say, in one plain-language paragraph, what it shows — a first-time visitor
 * lands on a surface and should not have to guess. These are structural assertions (the intro
 * exists, is styled, and carries no per-call data), not copy assertions: the wording is free to
 * change, its presence is not.
 */

const callsPage: CallsPage = {
  items: [],
  page: 1,
  page_size: 50,
  total: 0,
  total_pages: 1,
  filter: 'all',
};

const knowledgeView: KnowledgeView = {
  filters: {},
  page: 1,
  page_size: 50,
  total: 0,
  total_pages: 1,
  results: [],
  summary: {
    total: 0,
    date_span: { from: null, to: null },
    by_service_category: [],
    by_call_intent: [],
    by_urgency: [],
    narrative: 'No records match the current filters.',
  },
};

const reviewList: ReviewList = { items: [], generated_at: '2026-07-30T00:00:00.000Z' };

const reviewDetail: ReviewDetail = {
  id: 'rev-1',
  call_id: 'call-1',
  held_reason: 'classifier_uncertain',
  explanation: 'The classifier was not confident enough to decide.',
  status: 'open',
  assignee: null,
  sla_due_at: null,
  sla_state: 'ok',
  escalated: false,
  raw_purged: false,
  created_at: '2026-07-30T00:00:00.000Z',
  resolved_at: null,
  raw_available: false,
  redacted_content_available: true,
  redacted_content: 'Customer [NAME_1] called about a leak.',
  redacted_content_withheld_reason: null,
  extracted: null,
  allowed_actions: ['approve', 'mark_non_customer'],
};

const PAGES: ReadonlyArray<{ name: string; html: string }> = [
  { name: 'home', html: renderHome() },
  { name: 'pipeline health', html: renderStatusPage(makeStatusDto()) },
  { name: 'all calls', html: renderCallsPage(callsPage) },
  { name: 'knowledge base', html: renderKnowledgePage(knowledgeView) },
  { name: 'review queue', html: renderReviewListPage(reviewList) },
  {
    name: 'review detail',
    html: renderReviewDetailPage(reviewDetail, { csrfToken: 't', elevated: false, nonce: 'n' }),
  },
];

describe('every view describes itself', () => {
  it.each(PAGES)('$name carries a description paragraph', ({ html }) => {
    // The home page uses its own `.lead` paragraph; the inner surfaces use the shared helper.
    expect(html).toMatch(/class="(page-intro|lead)"/);
  });

  it.each(PAGES.filter((p) => p.name !== 'home'))(
    '$name styles the shared intro (THEME is prepended)',
    ({ html }) => {
      expect(html).toContain('.page-intro');
    },
  );

  it.each(PAGES)('$name keeps its description at least a sentence long', ({ html }) => {
    const m = /<p class="(?:page-intro|lead[^"]*)">([\s\S]*?)<\/p>/.exec(html);
    expect(m).not.toBeNull();
    const text = (m?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    expect(text.length).toBeGreaterThan(80);
  });

  it('the shared theme defines the intro style exactly once', () => {
    expect(THEME.match(/\.page-intro\s*\{/g)).toHaveLength(1);
  });

  it('escapes its input like the rest of the chrome', () => {
    expect(pageIntro('<script>alert(1)</script>')).toBe(
      '<p class="page-intro">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });
});
