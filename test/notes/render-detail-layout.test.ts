import { describe, expect, it } from 'vitest';
import { renderNoteDetailPage } from '../../src/notes/render.js';
import { makeNoteDetail } from './_fixture.js';

/**
 * Where things sit on the detail page, and what they are called.
 *
 * Reading order is the feature here: a reviewer judges the dispatch summary against the call, so
 * the way to hear the call must sit beside the summary rather than at the far end of forty
 * judgeable fields. These are index comparisons over the emitted HTML — crude, but they are the
 * only assertions that actually break when a block is moved.
 */
const html = renderNoteDetailPage(makeNoteDetail(), { nonce: 'N1', csrfToken: 'C1' });

describe('detail page reading order', () => {
  it('offers the transcript immediately after the dispatch summary, before the field groups', () => {
    const summary = html.indexOf('class="summary-card"');
    const button = html.indexOf('id="open-transcript"');
    const firstGroupHeading = html.indexOf('<h2>');

    expect(summary).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(summary);
    expect(firstGroupHeading).toBeGreaterThan(-1);
    expect(button).toBeLessThan(firstGroupHeading);
  });

  it('keeps exactly one transcript button — moving it must not leave a second behind', () => {
    expect(html.match(/id="open-transcript"/g)).toHaveLength(1);
  });
});

describe('field-group headings say what the group holds', () => {
  it('names the equipment group after the equipment, not after truck stock', () => {
    // "What's on the truck" read as a list of parts the van already carries, which is the
    // opposite of what the group is: what the technician is being sent to.
    expect(html).not.toContain('truck');
    expect(html).toContain('<h2>The equipment and the property</h2>');
  });

  it('still renders the equipment fields under that heading', () => {
    const heading = html.indexOf('<h2>The equipment and the property</h2>');
    const brand = html.indexOf('id="field-equipment.brand"');
    const nextHeading = html.indexOf('<h2>', heading + 1);

    expect(brand).toBeGreaterThan(heading);
    expect(brand).toBeLessThan(nextHeading);
  });
});
