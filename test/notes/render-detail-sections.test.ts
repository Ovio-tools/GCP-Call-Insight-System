import { describe, expect, it } from 'vitest';
import { renderNoteDetailPage } from '../../src/notes/render.js';
import { makeNoteDetail } from './_fixture.js';

/**
 * The three field groups are collapsible sections, closed on arrival.
 *
 * Thirty-four judgeable fields, each with its own row of four verdict buttons, made the detail
 * page a single unbroken scroll — on a phone the reviewer scrolled past everything to reach
 * anything. Each group heading is now a tap-to-open disclosure, so the page arrives as a short
 * list: the dispatch summary, the transcript button, three closed headings.
 *
 * Native <details>, no JavaScript: `src/ui/cards.ts` states the rule for these pages, and
 * `render-csp.test.ts` enforces the CSP side of it. The gap list at the foot deliberately does
 * NOT collapse.
 */
const html = renderNoteDetailPage(makeNoteDetail(), { nonce: 'N1', csrfToken: 'C1' });

const HEADINGS = [
  'The equipment and the property',
  'Getting in and getting it done',
  'What the office promised',
] as const;

/** The three section bodies, in page order. Splitting on the opening tag rather than matching a
 * regex means a section that loses its wrapper disappears from this list instead of quietly
 * merging into its neighbour. */
function sectionBodies(page: string): string[] {
  return page
    .split('<details class="dsection">')
    .slice(1)
    .map((s) => s.slice(0, s.indexOf('</details>')));
}

/** A single CSS rule body, sliced selector-to-`}`. The precedent is
 * `test/knowledge/render.test.ts` — class names alone prove nothing, so assert the declarations. */
function rule(page: string, selector: string): string {
  const at = page.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return page.slice(at, page.indexOf('}', at));
}

describe('collapsible field groups', () => {
  it('wraps each of the three groups in its own disclosure', () => {
    expect(sectionBodies(html)).toHaveLength(3);
  });

  it('leaves every section closed on arrival', () => {
    // The whole point: the page must be short when it loads. An `open` attribute on any of them
    // gives back the scroll this change exists to remove.
    expect(html).not.toMatch(/<details[^>]*class="dsection"[^>]*\sopen/);
  });

  it('puts each heading in the summary, still as a real <h2>', () => {
    // Heading content is valid <summary> content, and keeping the <h2> keeps the page navigable
    // by heading for a screen reader — a plain string in the summary would not be.
    for (const heading of HEADINGS) {
      expect(html).toContain(`<summary><h2>${heading}</h2></summary>`);
    }
  });

  it.each([
    [0, 'The equipment and the property', 'id="field-equipment.brand"'],
    [1, 'Getting in and getting it done', 'id="field-access_notes"'],
    [2, 'What the office promised', 'id="field-commitments_made.price_quoted"'],
  ])('keeps section %i (%s) holding its own fields', (index, heading, field) => {
    const bodies = sectionBodies(html);
    const mine = bodies[index] ?? '';

    expect(mine).toContain(`<h2>${heading}</h2>`);
    expect(mine).toContain(field);
    // ...and nobody else's section swallowed it.
    bodies
      .filter((_, i) => i !== index)
      .forEach((other) => {
        expect(other).not.toContain(field);
      });
  });

  it('leaves the gap list at the foot uncollapsed', () => {
    // "Not confirmed on this call" is short and is the thing a reviewer should not be able to
    // skip past, so it stays open — after the last section, outside every <details>.
    const gaps = html.indexOf('<h2>Not confirmed on this call</h2>');

    expect(gaps).toBeGreaterThan(html.lastIndexOf('</details>'));
    sectionBodies(html).forEach((body) => {
      expect(body).not.toContain('Not confirmed on this call');
    });
  });
});

describe('the disclosure reads as tappable', () => {
  it('keeps the triangle and a 44px tap target on the summary', () => {
    // <summary> defaults to display:list-item; overriding `display` suppresses the marker, and on
    // a touch device the triangle is the only cue the row is tappable. The same mistake has
    // already been made twice on the sibling summaries in this repo.
    const summary = rule(html, '.dsection > summary');

    expect(summary).toContain('display: list-item');
    expect(summary).toContain('min-height: 44px');
  });

  it('flattens the heading into the summary line', () => {
    // The base stylesheet gives h2 `margin: 24px 0 8px` and block display. Left alone, that drops
    // the heading onto the line below the triangle and stretches the row well past its padding,
    // so the marker and its label no longer read as one control.
    const inSummary = rule(html, '.dsection > summary h2');

    expect(inSummary).toContain('display: inline');
    expect(inSummary).toContain('margin: 0');
  });
});
