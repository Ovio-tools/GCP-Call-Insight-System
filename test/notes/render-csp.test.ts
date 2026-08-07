import { describe, expect, it } from 'vitest';
import {
  renderNoteDetailPage,
  renderNoteMissingPage,
  renderNotesListPage,
} from '../../src/notes/render.js';
import { makeNoteDetail, makeNoteList } from './_fixture.js';

/**
 * The strict-CSP contract for every page this surface renders: no external assets, no inline event
 * handler attributes, and a nonce on every `<script>`.
 *
 * The inline-handler assertion is a guard this repo did not previously have. It matters most here
 * because this is the first surface with real client-side behaviour (a modal and a POST), so the
 * temptation to reach for `onclick=` is real — and under the helmet CSP that markup silently does
 * nothing, which is a far worse failure than a visible error.
 */

/** Any `on*="…"` attribute on a tag — `onclick`, `onsubmit`, `onclose`, … */
const INLINE_HANDLER = /<[^>]+\son[a-z]+\s*=/i;

const PAGES: readonly { name: string; html: string }[] = [
  { name: 'list', html: renderNotesListPage(makeNoteList(), { nonce: 'N1', csrfToken: 'C1' }) },
  {
    name: 'detail',
    html: renderNoteDetailPage(makeNoteDetail(), { nonce: 'N1', csrfToken: 'C1' }),
  },
  { name: 'missing', html: renderNoteMissingPage({ nonce: 'N1', csrfToken: 'C1' }) },
];

describe('note-review pages are CSP-safe', () => {
  for (const page of PAGES) {
    describe(`${page.name} page`, () => {
      it('is a self-contained document with no external asset references', () => {
        expect(page.html.toLowerCase()).toContain('<!doctype html>');
        expect(page.html).toContain('</html>');
        expect(page.html).not.toMatch(/<link[^>]+href="https?:/i);
        expect(page.html).not.toMatch(/<script[^>]+src=/i);
        expect(page.html).not.toMatch(/<img/i);
      });

      it('uses no inline event handler attributes', () => {
        const offender = INLINE_HANDLER.exec(page.html);
        expect(offender?.[0] ?? null, `inline handler found: ${offender?.[0] ?? ''}`).toBeNull();
      });

      it('stamps the nonce on every script tag', () => {
        const tags = page.html.match(/<script\b[^>]*>/g) ?? [];
        expect(tags.length, 'page has at least one script').toBeGreaterThan(0);
        for (const tag of tags) {
          expect(tag, `script without the nonce: ${tag}`).toContain('nonce="N1"');
        }
      });
    });
  }

  it('the inline-handler regex actually matches a handler (self-test)', () => {
    // Without this the assertion above could pass on a broken regex rather than on clean markup.
    expect(INLINE_HANDLER.test('<button onclick="go()">x</button>')).toBe(true);
    expect(INLINE_HANDLER.test('<dialog onclose="x()"></dialog>')).toBe(true);
    // A legitimate attribute whose name merely starts with "on" must not trip it.
    expect(INLINE_HANDLER.test('<div data-only="1"></div>')).toBe(false);
  });

  it('escapes hostile note content rather than emitting it as markup', () => {
    const hostile = '<script>alert("x")</script>';
    const html = renderNoteDetailPage(
      makeNoteDetail((d) => {
        d.dispatch_summary = hostile;
        d.access_notes = hostile;
        d.symptom_verbatim = hostile;
        d.hazards = [hostile];
      }),
      { nonce: 'N1', csrfToken: 'C1' },
    );
    expect(html).not.toContain('<script>alert');
    // Once per field, and none swallowed by a helper that forgot to escape.
    expect(html.split('&lt;script&gt;').length - 1).toBeGreaterThanOrEqual(4);
    // The only scripts on the page are still our own nonce'd ones.
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag).toContain('nonce="N1"');
    }
  });
});
