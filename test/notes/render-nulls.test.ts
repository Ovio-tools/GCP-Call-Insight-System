import { describe, expect, it } from 'vitest';
import { NOTE_FIELD_PATHS } from '../../src/db/enums.js';
import { renderNoteDetailPage, renderNotesListPage } from '../../src/notes/render.js';
import { makeNoteDetail, makeNoteList, makeTally } from './_fixture.js';

/**
 * Absence is the finding on this surface, so a null field must RENDER — not be omitted the way
 * `cardField` omits one on a knowledge card. These assertions are region-scoped to the field they
 * are about: a whole-page `toContain('not stated on the call')` would pass off any one null field,
 * which is precisely the hole a page full of silently-dropped fields would slip through.
 */

/** Slice out one field's block by its stable id, so an assertion cannot be satisfied elsewhere. */
function fieldBlock(html: string, path: string): string {
  const start = html.indexOf(`id="field-${path}"`);
  if (start === -1) return '';
  const end = html.indexOf('id="field-', start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe('null note fields render as "not stated", never omitted', () => {
  const html = renderNoteDetailPage(
    makeNoteDetail((d) => {
      d.access_notes = null;
      d.location_on_property = null;
      d.equipment = { ...d.equipment, brand: null, capacity: null };
      d.water_status = { ...d.water_status, active_damage: null };
      d.hazards = [];
      d.scope_signal = 'unknown';
      d.not_established = ['access_notes', 'equipment.capacity', 'location_on_property'];
    }),
    { nonce: 'N1', csrfToken: 'C1' },
  );

  it('renders every addressable field, including the null ones', () => {
    // The judgeable groups cover every path except the gap list and the headline summary, which
    // are rendered separately. If a null field were dropped, its block would be missing.
    const separately = new Set(['not_established', 'dispatch_summary']);
    for (const path of NOTE_FIELD_PATHS) {
      if (separately.has(path)) continue;
      expect(fieldBlock(html, path), `no block rendered for ${path}`).not.toBe('');
    }
  });

  it('shows the muted "not stated on the call" treatment in each null field, not an empty value', () => {
    for (const path of [
      'access_notes',
      'location_on_property',
      'equipment.brand',
      'equipment.capacity',
      'water_status.active_damage',
    ]) {
      const block = fieldBlock(html, path);
      expect(block, `${path} block missing`).not.toBe('');
      expect(block, `${path} did not render the absence`).toContain(
        '<span class="unset">not stated on the call</span>',
      );
    }
  });

  it('treats an empty array and an "unknown" enum as the same absence', () => {
    // Two more ways a field can be empty. A reviewer should see ONE idea of "we don't know", not
    // three different renderings of it.
    expect(fieldBlock(html, 'hazards')).toContain('not stated on the call');
    expect(fieldBlock(html, 'scope_signal')).toContain('not stated on the call');
  });

  it('still renders populated fields with their values', () => {
    // The counterweight: if the renderer nulled everything, the assertions above would pass.
    expect(fieldBlock(html, 'equipment.type')).toContain('Tank water heater');
    expect(fieldBlock(html, 'water_status.supply_shut_off')).toContain('Yes');
    expect(fieldBlock(html, 'prior_work.is_repeat_visit')).toContain('No');
  });

  it('lists the unestablished fields under the gap heading, in plain language', () => {
    expect(html).toContain('Not confirmed on this call');
    const gaps = html.slice(html.indexOf('<ul class="gaps">'), html.indexOf('</ul>'));
    expect(gaps).toContain('Getting in'); // access_notes
    expect(gaps).toContain('Capacity'); // equipment.capacity
    expect(gaps).toContain('Where on the property'); // location_on_property
    // No snake_case field name reaches the screen.
    expect(gaps).not.toContain('access_notes');
    expect(gaps).not.toContain('equipment.capacity');
  });

  it('says so plainly when nothing is outstanding', () => {
    const clean = renderNoteDetailPage(
      makeNoteDetail((d) => (d.not_established = [])),
      {},
    );
    expect(clean).toContain('Nothing outstanding');
  });

  it('renders a missing dispatch summary as an explanation, not a blank panel', () => {
    const noSummary = renderNoteDetailPage(
      makeNoteDetail((d) => (d.dispatch_summary = null)),
      {},
    );
    expect(noSummary).toContain('No dispatch summary was written for this call.');
  });
});

describe('the running tally is labelled as a count, never as an accuracy score', () => {
  it('states the figure and the caveat together', () => {
    const html = renderNoteDetailPage(
      makeNoteDetail((d) => (d.tally = makeTally({ fields_checked: 10, marked_right: 7 }))),
      {},
    );
    // The apostrophe arrives escaped — the headline goes through `esc` like every other
    // interpolated string, and asserting the escaped form is what proves it was not exempted.
    expect(html).toContain('You&#39;ve checked 10 fields across all notes at this version.');
    expect(html).toContain('You marked 7 of them right (70%).');
    expect(html).toContain('This is a count of what you chose to look at, not an accuracy score.');
    // The words we must never use for this number.
    expect(html).not.toMatch(/accuracy score of|accuracy rate|% accurate/i);
  });

  it('says nothing at all before the reviewer has checked anything', () => {
    const html = renderNoteDetailPage(
      makeNoteDetail((d) => (d.tally = makeTally({ fields_checked: 0, marked_right: 0 }))),
      {},
    );
    // An empty scoreboard is noise on a page whose whole job is the note. It stays in the markup
    // hidden, so the first verdict can reveal it without a reload, but nothing reads as text.
    expect(html).not.toContain('haven&#39;t checked');
    expect(html).not.toContain('NaN');
    expect(html).toContain('<div class="tally" hidden>');
  });

  it('reveals that hidden tally, caveat and all, as soon as a verdict lands', () => {
    const html = renderNoteDetailPage(
      makeNoteDetail((d) => (d.tally = makeTally({ fields_checked: 0, marked_right: 0 }))),
      {},
    );
    // The caveat travels with the figure — it must already be inside the block that gets revealed.
    expect(html).toContain('not an accuracy score');
    const scripts = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []).join('\n');
    expect(scripts).toContain("removeAttribute('hidden')");
  });

  it('hides the empty tally on the list page too', () => {
    const html = renderNotesListPage(
      makeNoteList((l) => (l.tally = makeTally({ fields_checked: 0, marked_right: 0 }))),
      {},
    );
    expect(html).not.toContain('haven&#39;t checked');
    expect(html).toContain('<div class="tally" hidden>');
  });
});
