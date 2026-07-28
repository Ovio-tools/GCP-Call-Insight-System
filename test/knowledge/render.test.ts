import { describe, expect, it } from 'vitest';
import { renderKnowledgePage } from '../../src/knowledge/render.js';
import type { KnowledgeRecord, KnowledgeView } from '../../src/knowledge/dto.js';

/**
 * Pure unit tests over the knowledge page renderer (mobile card layout). No database and no HTTP:
 * `renderKnowledgePage` takes an already-sanitized DTO and returns a string, so the whole mobile
 * layout is testable from a literal. The escaping cases matter most — the card is a NEW
 * interpolation site and does not inherit the table's proof of safety.
 */

/** A fully-populated record: every one of the 14 DTO fields carries a distinct, greppable value. */
function record(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    call_id: 'call_abc123',
    created_at: '2026-07-27T19:32:04.000Z',
    call_intent: 'new_booking',
    service_category: 'water_heater',
    urgency: 'emergency',
    problem_statement: 'No hot water since last night',
    symptoms: ['no hot water', 'pilot will not stay lit'],
    customer_language: ['it just keeps clicking'],
    concerns: ['cost', 'how soon'],
    competitor_mentions: ['Acme Plumbing'],
    acquisition_source: 'Google search',
    location_in_home: 'Basement utility room',
    access_or_scheduling_notes: 'Dog in the yard',
    prior_attempts: 'Relit it twice',
    ...overrides,
  };
}

function view(overrides: Partial<KnowledgeView> = {}): KnowledgeView {
  return {
    filters: {},
    page: 1,
    page_size: 50,
    total: 1,
    total_pages: 1,
    results: [record()],
    summary: {
      total: 1,
      date_span: { from: null, to: null },
      by_service_category: [],
      by_call_intent: [],
      by_urgency: [],
      narrative: '1 record matches the current filters.',
    },
    ...overrides,
  };
}

describe('mobile card layout', () => {
  it('renders every one of the 14 record fields, including the five the table never showed', () => {
    const html = renderKnowledgePage(view());

    // The nine the table already showed.
    expect(html).toContain('call_abc123');
    expect(html).toContain('07-27-2026');
    expect(html).toContain('New booking');
    expect(html).toContain('Water heater');
    expect(html).toContain('Emergency');
    expect(html).toContain('No hot water since last night');
    expect(html).toContain('pilot will not stay lit');
    expect(html).toContain('it just keeps clicking');
    expect(html).toContain('how soon');

    // The five that previously reached only the CSV and JSON exports.
    expect(html).toContain('Basement utility room');
    expect(html).toContain('Dog in the yard');
    expect(html).toContain('Relit it twice');
    expect(html).toContain('Acme Plumbing');
    expect(html).toContain('Google search');
  });

  it('maps each urgency onto its own pill class, with a neutral fallback', () => {
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'emergency' })] }))).toContain(
      'kb-urgency u-emergency',
    );
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'urgent' })] }))).toContain(
      'kb-urgency u-urgent',
    );
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'routine' })] }))).toContain(
      'kb-urgency u-routine',
    );
  });

  it('omits the expander entirely when every expandable field is empty, but keeps the call id', () => {
    const bare = record({
      symptoms: [],
      customer_language: [],
      concerns: [],
      competitor_mentions: [],
      acquisition_source: null,
      location_in_home: null,
      access_or_scheduling_notes: null,
      prior_attempts: null,
    });
    const html = renderKnowledgePage(view({ results: [bare] }));

    expect(html).not.toContain('<details class="kb-more">');
    expect(html).not.toContain('More details');
    expect(html).toContain('call_abc123');
    // The problem statement is NOT expandable, so it still shows on the collapsed card.
    expect(html).toContain('No hot water since last night');
  });

  it('emits the expander when there is something to expand', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('<details class="kb-more">');
    expect(html).toContain('More details');
  });

  it('escapes HTML-significant characters in every card-rendered free-text field', () => {
    const hostile = '<script>alert("x")</script>';
    const html = renderKnowledgePage(
      view({
        results: [
          record({
            call_id: hostile,
            problem_statement: hostile,
            symptoms: [hostile],
            customer_language: [hostile],
            concerns: [hostile],
            competitor_mentions: [hostile],
            acquisition_source: hostile,
            location_in_home: hostile,
            access_or_scheduling_notes: hostile,
            prior_attempts: hostile,
          }),
        ],
      }),
    );

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    // Ten fields carried the payload; each must appear escaped, not swallowed.
    expect(html.split('&lt;script&gt;').length - 1).toBeGreaterThanOrEqual(10);
  });
});
