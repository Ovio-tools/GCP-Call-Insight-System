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

/** The `<div class="kb-cards">…</div>` region only. Depth-counted, because cards contain nested
 *  divs and later tasks add markup after the list — a slice to the first `</div>` would lie. */
function cardsOf(html: string): string {
  const open = '<div class="kb-cards">';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('no kb-cards region in the rendered page');
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error('unbalanced kb-cards region');
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
    expect(cardsOf(html)).toContain('call_abc123');
    expect(cardsOf(html)).toContain('07-27-2026');
    expect(cardsOf(html)).toContain('New booking');
    expect(cardsOf(html)).toContain('Water heater');
    expect(cardsOf(html)).toContain('Emergency');
    expect(cardsOf(html)).toContain('No hot water since last night');
    expect(cardsOf(html)).toContain('pilot will not stay lit');
    expect(cardsOf(html)).toContain('it just keeps clicking');
    expect(cardsOf(html)).toContain('how soon');

    // The five that previously reached only the CSV and JSON exports.
    expect(cardsOf(html)).toContain('Basement utility room');
    expect(cardsOf(html)).toContain('Dog in the yard');
    expect(cardsOf(html)).toContain('Relit it twice');
    expect(cardsOf(html)).toContain('Acme Plumbing');
    expect(cardsOf(html)).toContain('Google search');

    // Labels must stay attached to their own values — a transposition is exactly the defect a
    // reader reports and a maintainer cannot reproduce.
    expect(cardsOf(html)).toContain('<dt>Where in the home</dt><dd>Basement utility room</dd>');
    expect(cardsOf(html)).toContain(
      '<dt>Symptoms</dt><dd><span class="kb-chip">no hot water</span>',
    );
  });

  it('maps each urgency onto its own pill class, with a neutral fallback', () => {
    expect(
      cardsOf(renderKnowledgePage(view({ results: [record({ urgency: 'emergency' })] }))),
    ).toContain('kb-urgency u-emergency');
    expect(
      cardsOf(renderKnowledgePage(view({ results: [record({ urgency: 'urgent' })] }))),
    ).toContain('kb-urgency u-urgent');
    expect(
      cardsOf(renderKnowledgePage(view({ results: [record({ urgency: 'routine' })] }))),
    ).toContain('kb-urgency u-routine');
    expect(
      cardsOf(
        renderKnowledgePage(
          view({ results: [record({ urgency: 'triage_pending' as KnowledgeRecord['urgency'] })] }),
        ),
      ),
    ).toContain('kb-urgency u-other');
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

    expect(cardsOf(html)).not.toContain('<details class="kb-more">');
    expect(cardsOf(html)).not.toContain('More details');
    expect(cardsOf(html)).toContain(
      '<p class="kb-callid mono" title="call_abc123">call_abc123</p>',
    );
    // The problem statement is NOT expandable, so it still shows on the collapsed card.
    expect(cardsOf(html)).toContain('No hot water since last night');
  });

  it('emits the expander when there is something to expand', () => {
    const html = renderKnowledgePage(view());
    expect(cardsOf(html)).toContain('<details class="kb-more">');
    expect(cardsOf(html)).toContain('More details');
  });

  it('renders one card per record, in row order', () => {
    const html = renderKnowledgePage(
      view({
        results: [record({ call_id: 'call_first' }), record({ call_id: 'call_second' })],
        total: 2,
      }),
    );
    const region = cardsOf(html);
    // Matches the opening tag by its class attribute only (not the full `>`) so this stays
    // correct regardless of what other attributes (e.g. aria-label) the tag carries.
    expect(region.split('<article class="kb-card"').length - 1).toBe(2);
    expect(region.indexOf('call_first')).toBeLessThan(region.indexOf('call_second'));
  });

  it('renders an empty card region when nothing matches', () => {
    const html = renderKnowledgePage(view({ results: [], total: 0, total_pages: 0 }));
    expect(html).toContain('<div class="kb-cards"></div>');
    expect(cardsOf(html)).not.toContain('<article');
  });

  it('includes only the populated blocks when a record is partly filled', () => {
    const html = renderKnowledgePage(
      view({ results: [record({ symptoms: [], prior_attempts: null })] }),
    );
    const region = cardsOf(html);
    expect(region).toContain('<dt>Concerns</dt>');
    expect(region).not.toContain('<dt>Symptoms</dt>');
    expect(region).not.toContain('<dt>Already tried</dt>');
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
