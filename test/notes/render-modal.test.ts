import { describe, expect, it } from 'vitest';
import { renderNoteDetailPage } from '../../src/notes/render.js';
import { makeNoteDetail } from './_fixture.js';

/**
 * The transcript modal. This is the first `<dialog>` in the codebase, so these assertions pin the
 * pattern the next one should copy: native element, one dismissal path, focus returned, scroll
 * unlocked, transcript fetched on open rather than embedded in the page.
 *
 * Render-level, not browser-level: the assertions confirm the handlers are WIRED and nonce'd. They
 * are string matches against emitted script text, which is the same trade `test/knowledge/render.test.ts`
 * makes for CSS, and they are paired with the CSP suite that proves no handler hides in an
 * attribute instead.
 */
const html = renderNoteDetailPage(makeNoteDetail(), { nonce: 'N1', csrfToken: 'C1' });

/** The page's inline scripts, concatenated — where every behaviour must live under strict CSP. */
const scripts = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []).join('\n');

describe('transcript modal', () => {
  it('uses a native <dialog> opened with showModal(), not a hand-rolled overlay', () => {
    expect(html).toContain('<dialog class="transcript" id="transcript"');
    expect(scripts).toContain('showModal()');
    // A div overlay would need its own z-index/backdrop; the native element brings the top layer.
    expect(html).toContain('dialog.transcript::backdrop');
  });

  it('wires all three dismissal routes, and they converge on ONE close handler', () => {
    // 1. The close button asks the dialog to close.
    expect(html).toContain('id="close-transcript"');
    expect(scripts).toContain("closeBtn.addEventListener('click'");
    // 2. Backdrop: a click whose target IS the dialog landed outside the content box.
    expect(scripts).toContain("dlg.addEventListener('click'");
    expect(scripts).toContain('e.target===dlg');
    // 3. Escape is native — <dialog> fires `close` for it, the same event the other two reach via
    //    dlg.close(). Exactly ONE `close` listener exists, so the three cannot drift apart.
    expect(scripts).toContain("dlg.addEventListener('close'");
    expect(scripts.match(/addEventListener\('close'/g)).toHaveLength(1);
    // Both explicit routes go through dlg.close() rather than doing their own teardown.
    expect(scripts.match(/dlg\.close\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('returns focus to the triggering button and unlocks scrolling on close', () => {
    expect(scripts).toContain('lastTrigger=opener');
    expect(scripts).toContain('lastTrigger.focus()');
    expect(scripts).toContain("document.body.style.overflow='hidden'");
    expect(scripts).toContain("document.body.style.overflow=''");
  });

  it('fetches the transcript on open — never prefetched, never embedded in the page', () => {
    expect(scripts).toContain('/transcript.json');
    expect(scripts).toContain('Loading the transcript');
    // The note's own text is in the page; the TRANSCRIPT body must not be. The modal body ships
    // empty and is filled by the fetch.
    expect(html).toContain('<div class="dlg-body" id="transcript-body"></div>');
  });

  it('explains the unavailable and withheld states as sentences, not as errors', () => {
    expect(scripts).toContain('no longer stored');
    expect(scripts).toContain('may be personal information');
    // Neither state is dressed up as a failure the reader caused.
    expect(scripts).not.toMatch(/withheld['"]\s*\?\s*['"]Error/i);
  });

  it('renders speaker turns and inserts transcript text with textContent, never innerHTML', () => {
    expect(scripts).toContain("d.className=who?'turn':'turn no-speaker'");
    expect(scripts).toContain('p.textContent=said');
    // innerHTML on fetched transcript text would re-open the injection door the escaping closes.
    expect(scripts).not.toContain('innerHTML');
  });

  it('carries the one-line explanation of what the reader is looking at', () => {
    expect(html).toContain('This is the version the system read, with personal details removed.');
  });

  it('runs entirely from nonce-carrying scripts', () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag).toContain('nonce="N1"');
    }
  });
});
