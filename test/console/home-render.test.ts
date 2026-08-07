import { describe, expect, it } from 'vitest';
import { renderHome } from '../../src/console/home-render.js';

/**
 * The combined-console home page (single entry point). Pure, self-contained HTML: one link to each
 * internal surface, no external assets, no PII. Every surface the console mounts must be reachable
 * from here so a signed-in user never has to type a path.
 */
describe('console home render', () => {
  const html = renderHome();

  it('is a self-contained HTML document with no external asset references', () => {
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('</html>');
    // No external stylesheets/scripts/images — the surfaces are strictly self-contained.
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<img/i);
  });

  it('links to every internal surface', () => {
    for (const path of ['/status', '/calls', '/knowledge', '/review', '/notes']) {
      expect(html, `missing link to ${path}`).toContain(`href="${path}"`);
    }
  });

  it('offers a logout affordance', () => {
    // Logout is a POST; the page wires it without any third-party script.
    expect(html).toContain('/auth/logout');
  });
});
