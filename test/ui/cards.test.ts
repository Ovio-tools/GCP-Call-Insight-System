import { describe, expect, it } from 'vitest';
import { CARD_STYLE, cardField } from '../../src/ui/cards.js';

/**
 * Direct unit tests over the SHARED mobile card system. Until now every assertion about
 * `cardField`/`CARD_STYLE` reached them through `renderKnowledgePage`, which was fine while this
 * code WAS the knowledge page. It is shared now: `/calls` becomes a second consumer, so a change
 * that breaks the contract must fail here once, rather than only in whichever consumer happens to
 * carry a duplicate copy of the same assertions — that duplication is exactly what extracting this
 * module removed, and asserting only through consumers would reinstate it one layer up.
 *
 * The `CARD_STYLE` assertions are LITERAL STRING MATCHES against the CSS text, not a parsed
 * stylesheet — reflowing whitespace inside a declaration will fail them even though the CSS is
 * equivalent. Same deliberate tradeoff as the knowledge page's render test.
 */

/** The BODY of the responsive block. A whole-string search would let a rule that merely exists
 *  somewhere in the sheet satisfy a mobile-only assertion, and vice versa. */
function mediaBlock(css: string): string {
  const open = '@media (max-width: 899px) {';
  const start = css.indexOf(open);
  if (start === -1) throw new Error('no mobile media query in CARD_STYLE');
  let depth = 0;
  for (let i = start + open.length - 1; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced media query');
}

/** Everything before the responsive block: the rules that apply at EVERY width. */
function baseRules(css: string): string {
  return css.slice(0, css.indexOf('@media (max-width: 899px)'));
}

describe('cardField', () => {
  // Every one of these is "absent, or effectively absent". The promise is that none of them costs
  // a blank labelled row or an empty chip, so they must all collapse to nothing at all.
  it.each([
    ['a null scalar', null],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['an empty array', []],
    ['an array whose every element is blank', ['', '  ']],
  ])('renders nothing for %s', (_label, value) => {
    expect(cardField('Symptoms', value as string | readonly string[] | null)).toBe('');
  });

  it('renders a scalar as a labelled field', () => {
    expect(cardField('Where in the home', 'Basement utility room')).toBe(
      '<div class="field"><dt>Where in the home</dt><dd>Basement utility room</dd></div>',
    );
  });

  it('renders an array as chip spans inside one labelled field', () => {
    expect(cardField('Symptoms', ['no hot water', 'pilot will not stay lit'])).toBe(
      '<div class="field"><dt>Symptoms</dt><dd>' +
        '<span class="chip">no hot water</span>' +
        '<span class="chip">pilot will not stay lit</span>' +
        '</dd></div>',
    );
  });

  it('drops only the blank elements of a mixed array, keeping the rest', () => {
    const html = cardField('Concerns', ['cost', '   ', 'how soon', '']);
    expect(html).toBe(
      '<div class="field"><dt>Concerns</dt><dd>' +
        '<span class="chip">cost</span>' +
        '<span class="chip">how soon</span>' +
        '</dd></div>',
    );
    // Two survivors means exactly two chips — a blank element must not become an empty one.
    expect(html.split('<span class="chip">').length - 1).toBe(2);
  });

  it('escapes HTML-significant characters in the label and in every value', () => {
    const hostile = '<script>alert("x")</script>';
    const escaped = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

    // A shared interpolation site needs its own proof; it does not inherit any consumer's.
    const scalar = cardField(hostile, hostile);
    expect(scalar).not.toContain('<script>');
    expect(scalar).toBe(`<div class="field"><dt>${escaped}</dt><dd>${escaped}</dd></div>`);

    const arr = cardField(hostile, [hostile]);
    expect(arr).not.toContain('<script>');
    expect(arr).toBe(
      `<div class="field"><dt>${escaped}</dt><dd><span class="chip">${escaped}</span></dd></div>`,
    );
  });
});

describe('CARD_STYLE', () => {
  it('hides the card list at every width and reveals it only below the breakpoint', () => {
    // Without the base rule the card list stacks underneath the desktop table at every width.
    expect(baseRules(CARD_STYLE)).toContain('.cards { display: none; }');
    expect(mediaBlock(CARD_STYLE)).toContain('.cards { display: block; }');
  });

  it('hands the layout over to the cards by hiding the table below the breakpoint', () => {
    expect(mediaBlock(CARD_STYLE)).toContain('.table-wrap { display: none; }');
  });

  it('qualifies the bottom-pager rules with BOTH classes so source order cannot decide them', () => {
    // A consumer's own `.pager { display: flex }` is (0,1,0). A single-class `.pager-bottom` rule
    // here would tie, making this block's placement in the stylesheet silently load-bearing.
    expect(baseRules(CARD_STYLE)).toContain('.pager.pager-bottom { display: none; }');
    expect(mediaBlock(CARD_STYLE)).toContain('.pager.pager-bottom { display: flex; }');
    expect(CARD_STYLE).not.toContain('\n.pager-bottom {');
  });

  it('raises mobile form controls to 16px so Safari stops force-zooming on focus', () => {
    // Load-bearing, not cosmetic: mobile Safari zooms the viewport for any focused control under
    // 16px, and both consumers inherit a 15px body font.
    expect(mediaBlock(CARD_STYLE)).toContain('font-size: 16px');
  });
});
