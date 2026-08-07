import { describe, expect, it } from 'vitest';
import { renderCallsPage } from '../../src/status/calls-render.js';
import { filtersScript } from '../../src/ui/filters.js';
import type { CallListItem, CallsPage } from '../../src/status/calls.js';

/**
 * Pure unit tests over the all-calls renderer (mobile card layout). No database and no HTTP.
 *
 * Assertions are scoped to the CARD REGION via `cardsOf`. The desktop table emits the same
 * strings, so a whole-page assertion passes even when the card is deleted — a class of vacuity
 * found repeatedly while building the knowledge-base equivalent (PR #107).
 *
 * The `mobileRules`/`base` assertions are LITERAL STRING MATCHES against rendered CSS text, not a
 * parsed stylesheet: reordering a selector list or reflowing whitespace fails them even though the
 * CSS is equivalent. Deliberate tradeoff — read a failure before assuming the styling regressed.
 */

function item(overrides: Partial<CallListItem> = {}): CallListItem {
  return {
    call_id: '6159886818426880',
    status: 'held',
    current_stage: 'fetch-transcript',
    created_at: '2026-07-28T14:32:00.000Z',
    updated_at: '2026-07-28T14:35:00.000Z',
    outcome: { key: 'held', label: 'Held', reason: 'Missing transcript' },
    ...overrides,
  };
}

function page(overrides: Partial<CallsPage> = {}): CallsPage {
  return {
    items: [item()],
    page: 1,
    page_size: 50,
    total: 1,
    total_pages: 1,
    filter: 'all',
    ...overrides,
  };
}

/** The `<div class="cards">…</div>` region only. Depth-counted: cards contain nested divs, and
 *  markup follows the list, so a slice to the first `</div>` would lie. */
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

/** The BODY of the mobile media query only. A slice to end-of-document would let a rule anywhere
 *  later in the stylesheet satisfy a mobile-only assertion. */
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

describe('outcome filter applies on selection', () => {
  // The behaviour itself is proven in test/ui/filters.test.ts by executing the script; all this
  // page owes is to actually carry it. Matching the whole emitted script (not a fragment of it)
  // means dropping the call here fails, and so does dropping the nonce it is rendered with.
  it('carries the shared auto-apply script, nonce and all', () => {
    const html = renderCallsPage(page(), { nonce: 'N1', csrfToken: 'C1' });
    expect(html).toContain(filtersScript({ nonce: 'N1' }));
  });

  it('emits the script after the filter form, which is the only order that works', () => {
    // The script wires the form the moment it runs. Hoisted into <head> it finds nothing to wire
    // and the drop-down silently goes back to needing the button, with no error anywhere.
    const html = renderCallsPage(page(), { nonce: 'N1', csrfToken: 'C1' });
    expect(html.indexOf(filtersScript({ nonce: 'N1' }))).toBeGreaterThan(
      html.lastIndexOf('<form class="filters"'),
    );
  });
});

describe('all-calls mobile cards', () => {
  it('renders every field of a call on the card', () => {
    const region = cardsOf(renderCallsPage(page()));
    expect(region).toContain('6159886818426880');
    // fmtTs renders the FULL date: `2026-07-28 14:32`, not a short `07-28`.
    expect(region).toContain('2026-07-28 14:32');
    expect(region).toContain('Held');
    expect(region).toContain('Missing transcript');
    expect(region).toContain('Fetch transcript');
  });

  it('shows Updated only when it actually differs from Created', () => {
    const differs = cardsOf(renderCallsPage(page()));
    expect(differs).toContain('<dt>Updated</dt>');
    expect(differs).toContain('2026-07-28 14:35');

    const same = cardsOf(
      renderCallsPage(page({ items: [item({ updated_at: '2026-07-28T14:32:00.000Z' })] })),
    );
    expect(same).not.toContain('<dt>Updated</dt>');
  });

  // Both shapes of "no reason", because the renderer guards both (`reason?.trim()`) and only the
  // null one is reachable today: `deriveOutcome` returns null or a non-blank string from a closed
  // enum. That guarantee rests on a database CHECK constraint, not the type system — `reason` is
  // typed `string | null` and `renderCallsPage` accepts ANY `CallsPage` — and `deriveOutcome`'s own
  // docblock takes the opposite posture for `status` (degrade rather than trust the enum). So the
  // guard stays, and both its cases get held to `cardField`'s five-case emptiness standard.
  it.each([
    ['there is no reason at all', null],
    ['the reason is whitespace only', '   '],
  ])('omits the reason line when %s', (_label, reason) => {
    const region = cardsOf(
      renderCallsPage(
        page({
          items: [item({ outcome: { key: 'customer_completed', label: 'Customer', reason } })],
        }),
      ),
    );
    expect(region).toContain('Customer');
    expect(region).not.toContain('class="card-meta"');
  });

  it('renders one card per call, in row order', () => {
    const region = cardsOf(
      renderCallsPage(
        page({
          items: [item({ call_id: 'call_first' }), item({ call_id: 'call_second' })],
          total: 2,
        }),
      ),
    );
    expect(region.split('<article class="card"').length - 1).toBe(2);
    expect(region.indexOf('call_first')).toBeLessThan(region.indexOf('call_second'));
  });

  it('tells the reader nothing matched, rather than showing a blank screen', () => {
    const region = cardsOf(renderCallsPage(page({ items: [], total: 0, total_pages: 0 })));
    expect(region).not.toContain('<article');
    expect(region).toContain('No calls match this filter yet.');
  });

  it('escapes HTML-significant characters in every card-rendered field', () => {
    const hostile = '<script>alert("x")</script>';
    // Scoped to the CARD region, not the page: the table escapes the same four values, so a
    // whole-page assertion here stays green with every `esc()` stripped out of `cardHtml` — the
    // exact vacuity this file's docblock warns about. The card is a NEW interpolation site and
    // inherits none of the table's proof.
    const region = cardsOf(
      renderCallsPage(
        page({
          items: [
            item({
              call_id: hostile,
              current_stage: hostile,
              outcome: { key: 'held', label: hostile, reason: hostile },
            }),
          ],
        }),
      ),
    );
    expect(region).not.toContain('<script>alert');
    expect(region).toContain('&lt;script&gt;');
    // Six interpolation sites carried the payload — the aria-label, the badge label, the reason,
    // the stage, and the call id twice (its `title` attribute and its text) — so each must appear
    // escaped rather than swallowed by a single lucky `esc()` somewhere.
    expect(region.split('&lt;script&gt;').length - 1).toBeGreaterThanOrEqual(6);
  });
});

describe('all-calls layout switch', () => {
  it('ships both layouts in one response', () => {
    const html = renderCallsPage(page());
    expect(html).toContain('class="cards"');
    expect(html).toContain('class="table-wrap table-scroll"');
  });

  it('hides the table and shows the cards below the breakpoint', () => {
    const html = renderCallsPage(page());
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.cards { display: none; }');
    expect(mobileRules(html)).toContain('.cards { display: block; }');
    expect(mobileRules(html)).toContain('.table-wrap { display: none; }');
  });

  it('raises mobile form controls to 16px so Safari stops force-zooming on focus', () => {
    expect(mobileRules(renderCallsPage(page()))).toContain('font-size: 16px');
  });

  it('splices CARD_STYLE after the page base rules, where the cascade needs it', () => {
    // Five of CARD_STYLE's media rules TIE on specificity with this page's base rules
    // (form.filters button/select at (0,1,2), form.filters at (0,1,1), main and h1 at (0,0,1)) and
    // are therefore decided by SOURCE ORDER alone. The "obvious" splice right after THEME silently
    // loses all five — 16px reverts to 15px and Safari resumes force-zooming, the 44px tap target
    // reverts to 40px — with nothing else in this suite failing, because `mobileRules(...) contains
    // 'font-size: 16px'` stays true when the rule is present but LOSES. So assert the ordering.
    const html = renderCallsPage(page());
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    // A rule from the page's OWN base CSS (and one of the five that ties), never from THEME or
    // CARD_STYLE — an anchor drawn from either of those would not pin the splice point.
    const anchor = base.indexOf('form.filters button { padding: 8px 16px;');
    const shared = base.indexOf('.cards { display: none; }');
    // Both must actually be found: a typo'd anchor returns -1 and every `>` comparison below would
    // then pass for entirely the wrong reason.
    expect(anchor).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThanOrEqual(0);
    expect(shared).toBeGreaterThan(anchor);
  });

  it('repeats the pager below the results, mobile-only', () => {
    const html = renderCallsPage(page({ page: 2, total_pages: 4, total: 168 }));
    expect(html).toContain('class="pager pager-bottom"');
    expect(html.split('Page 2 of 4').length - 1).toBe(2);
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.pager.pager-bottom { display: none; }');
    expect(mobileRules(html)).toContain('.pager.pager-bottom { display: flex; }');
  });

  it('gives the pager a 44px minimum tap target on mobile', () => {
    expect(mobileRules(renderCallsPage(page()))).toContain('min-height: 44px');
  });
});
