import { describe, expect, it } from 'vitest';
import { renderKnowledgePage } from '../../src/knowledge/render.js';
import type { KnowledgeRecord, KnowledgeView } from '../../src/knowledge/dto.js';

/**
 * Pure unit tests over the knowledge page renderer (mobile card layout). No database and no HTTP:
 * `renderKnowledgePage` takes an already-sanitized DTO and returns a string, so the whole mobile
 * layout is testable from a literal. The escaping cases matter most — the card is a NEW
 * interpolation site and does not inherit the table's proof of safety.
 *
 * The `mobileRules`/`base` assertions below are LITERAL STRING MATCHES against the rendered CSS
 * text, not a parsed stylesheet — reordering a selector list (e.g. `a, b { ... }` to `b, a { ... }`)
 * or reflowing the whitespace inside a declaration will fail them even though the CSS is equivalent.
 * That is a deliberate tradeoff (a real parser is a lot more test infrastructure for a page this
 * size), so a failure here is worth reading before assuming the styling regressed.
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

/** The `<div class="cards">…</div>` region only. Depth-counted, because cards contain nested
 *  divs and later tasks add markup after the list — a slice to the first `</div>` would lie. */
function cardsOf(html: string): string {
  const open = '<div class="cards">';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('no cards region in the rendered page');
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error('unbalanced cards region');
}

/** The BODY of the mobile media query only. A slice to end-of-document would let a rule that
 *  merely exists somewhere in the stylesheet satisfy a mobile-only assertion.
 *
 *  ASSUMPTION CHANGED: the page now emits TWO `@media (max-width: 899px)` blocks — the SHARED one
 *  from `src/ui/cards.ts` (`CARD_STYLE`) and, after it, the knowledge page's own. This helper takes
 *  the FIRST, so it means "the shared card block" and nothing else; a knowledge-specific rule must
 *  be asserted with {@link kbMobileRules}. Deliberately left matching the first block rather than
 *  spanning both: spanning would let a rule land in either file and still pass, which is exactly
 *  the shared-vs-page-specific distinction this refactor exists to keep honest. */
function mobileRules(html: string): string {
  const open = '@media (max-width: 899px) {';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('no mobile media query in the rendered page');
  let depth = 0;
  for (let i = start + open.length - 1; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced media query');
}

/** Everything AFTER the shared card media query — i.e. the knowledge page's own trailing chunk:
 *  its base rules followed by its own `@media (max-width: 899px)` block. */
function kbChunk(html: string): string {
  const shared = mobileRules(html);
  return html.slice(html.indexOf(shared) + shared.length);
}

/** The BODY of the knowledge page's OWN mobile media query (the second one). Same guarantee as
 *  {@link mobileRules}, for the rules that stayed page-specific. */
function kbMobileRules(html: string): string {
  return mobileRules(kbChunk(html));
}

/** The knowledge page's own base rules: the region BETWEEN the two media queries, so a rule proven
 *  here is proven to sit outside EVERY media query — the same strength the plain `base` slice used
 *  to have before `CARD_STYLE` was spliced in ahead of these rules. */
function kbBaseRules(html: string): string {
  const chunk = kbChunk(html);
  const idx = chunk.indexOf('@media (max-width: 899px)');
  if (idx === -1) throw new Error('no knowledge-specific media query in the rendered page');
  return chunk.slice(0, idx);
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
    const region = cardsOf(html);

    // The nine the table already showed.
    expect(region).toContain('call_abc123');
    expect(region).toContain('07-27-2026');
    expect(region).toContain('New booking');
    expect(region).toContain('Water heater');
    expect(region).toContain('Emergency');
    expect(region).toContain('No hot water since last night');
    expect(region).toContain('pilot will not stay lit');
    expect(region).toContain('it just keeps clicking');
    expect(region).toContain('how soon');

    // The five that previously reached only the CSV and JSON exports.
    expect(region).toContain('Basement utility room');
    expect(region).toContain('Dog in the yard');
    expect(region).toContain('Relit it twice');
    expect(region).toContain('Acme Plumbing');
    expect(region).toContain('Google search');

    // Labels must stay attached to their own values — a transposition is exactly the defect a
    // reader reports and a maintainer cannot reproduce.
    expect(region).toContain('<dt>Where in the home</dt><dd>Basement utility room</dd>');
    expect(region).toContain('<dt>Symptoms</dt><dd><span class="chip">no hot water</span>');
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
    expect(cardsOf(html)).toContain('<p class="callid mono" title="call_abc123">call_abc123</p>');
    // The problem statement is NOT expandable, so it still shows on the collapsed card.
    expect(cardsOf(html)).toContain('No hot water since last night');
  });

  it('falls back to the empty-problem message when the statement is whitespace-only', () => {
    const html = renderKnowledgePage(view({ results: [record({ problem_statement: '   ' })] }));
    const region = cardsOf(html);
    expect(region).toContain('<p class="kb-problem kb-empty">No problem statement recorded.</p>');
    expect(region).not.toContain('<p class="kb-problem">');
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
    expect(region.split('<article class="card"').length - 1).toBe(2);
    expect(region.indexOf('call_first')).toBeLessThan(region.indexOf('call_second'));
  });

  it('renders an empty card region when nothing matches', () => {
    const html = renderKnowledgePage(view({ results: [], total: 0, total_pages: 0 }));
    expect(html).toContain('<div class="cards"></div>');
    expect(cardsOf(html)).not.toContain('<article');
  });

  it('includes only the populated blocks when a record is partly filled, dropping whitespace-only values too', () => {
    // `symptoms: ['', '  ']` and `prior_attempts: '   '` are not EMPTY, just blank — `cardField`'s
    // doc comment promises these are dropped exactly like `[]`/`null`; this is what holds it to that.
    const html = renderKnowledgePage(
      view({ results: [record({ symptoms: ['', '  '], prior_attempts: '   ' })] }),
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

describe('layout switch', () => {
  it('ships both layouts in one response, since the choice is made client-side', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('class="cards"');
    expect(html).toContain('class="table-wrap table-scroll"');
  });

  it('hides the table and shows the cards below the 900px breakpoint', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('@media (max-width: 899px)');
    // Inside the breakpoint the roles invert: cards become visible, the table goes away.
    const mq = mobileRules(html);
    expect(mq).toContain('.cards { display: block; }');
    expect(mq).toContain('.table-wrap { display: none; }');
    // ...and the base rule that keeps the card list off the desktop page — without this, the
    // whole card list stacks underneath the desktop table at every width.
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.cards { display: none; }');
  });
});

describe('collapsible filters', () => {
  it('labels the bar plainly when nothing is filtered, and stays closed', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('<summary>Filters</summary>');
    expect(html).not.toContain('<details class="kb-filters-mobile" open>');
  });

  it('counts the active filters and opens the bar so a filtered view never hides why', () => {
    const html = renderKnowledgePage(view({ filters: { q: 'heater', urgency: 'emergency' } }));
    expect(html).toContain('Filters &middot; 2 active');
    expect(html).toContain('<details class="kb-filters-mobile" open>');
  });

  it('counts every filter kind, not just the free-text one', () => {
    const html = renderKnowledgePage(
      view({
        filters: {
          q: 'heater',
          service_category: 'water_heater',
          call_intent: 'new_booking',
          urgency: 'emergency',
          from: '2026-07-01',
          to: '2026-07-31',
        },
      }),
    );
    expect(html).toContain('Filters &middot; 6 active');
  });

  it('renders the form for both layouts', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('class="kb-filters-desktop"');
    expect(html).toContain('class="kb-filters-mobile"');
    // Both copies are real forms, so whichever one is visible can actually be submitted.
    expect(html.split('<form class="filters"').length - 1).toBe(2);
    // The class names alone prove nothing — assert the rules that actually do the switching.
    // These two live in the knowledge page's OWN mobile block, not the shared card one.
    expect(kbMobileRules(html)).toContain('.kb-filters-desktop { display: none; }');
    expect(kbMobileRules(html)).toContain('.kb-filters-mobile { display: block; }');
    // ...and the base rule that keeps the mobile bar off the desktop page.
    expect(kbBaseRules(html)).toContain('.kb-filters-mobile { display: none; }');
  });

  it('raises mobile form controls to 16px so Safari stops force-zooming on focus', () => {
    const html = renderKnowledgePage(view());
    expect(mobileRules(html)).toContain('font-size: 16px');
  });

  it.each(['.kb-filters-mobile > summary', '.kb-more > summary'])(
    'keeps the disclosure triangle on %s',
    (selector) => {
      // <summary> defaults to display:list-item; overriding `display` suppresses the marker, and on
      // a touch device the triangle is the only cue the element is tappable (cursor:pointer does
      // nothing). Both summaries in this page — the filter bar and the per-card "More details"
      // expander — made the identical mistake once already and must both stay pinned.
      const html = renderKnowledgePage(view());
      const summaryRule = html.slice(html.indexOf(selector));
      expect(summaryRule.slice(0, summaryRule.indexOf('}'))).toContain('display: list-item');
    },
  );
});

describe('mobile tap targets', () => {
  it('repeats the pager below the results so paging does not mean scrolling back up', () => {
    const html = renderKnowledgePage(view({ page: 2, total_pages: 4, total: 168 }));
    expect(html).toContain('class="pager pager-bottom"');
    // Above and below: the page indicator appears exactly twice.
    expect(html.split('Page 2 of 4').length - 1).toBe(2);
  });

  it('shows the bottom pager only on mobile, so desktop keeps its single one', () => {
    const html = renderKnowledgePage(view());
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.pager-bottom { display: none; }');
    expect(mobileRules(html)).toContain('.pager-bottom { display: flex; }');
  });

  it('gives the pager and export links a 44px minimum tap target on mobile', () => {
    const html = renderKnowledgePage(view());
    expect(mobileRules(html)).toContain('.pager a, .exports a { min-height: 44px;');
  });
});
