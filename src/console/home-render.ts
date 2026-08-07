import { THEME, esc, siteHeader, logoutScript, type Chrome } from '../ui/chrome.js';

/**
 * The combined-console home page (single entry point). Self-contained HTML — the shared {@link THEME}
 * tokens + a small page-specific nav-tile grid, the shared {@link siteHeader} (with a working
 * Sign-out), and one nonce'd inline script. Pure navigation: one tile per internal surface so a
 * signed-in user never has to type a path.
 */

export type RenderHomeOptions = Chrome;

interface SurfaceTile {
  href: string;
  title: string;
  blurb: string;
}

/** The surfaces the combined console mounts, in the order a person is most likely to want them. */
const TILES: readonly SurfaceTile[] = [
  {
    href: '/status',
    title: 'Pipeline health',
    blurb: 'Live system status and per-stage counts. No call content.',
  },
  {
    href: '/calls',
    title: 'All calls',
    blurb: 'Every call the pipeline has seen — including non-customer and skipped.',
  },
  {
    href: '/knowledge',
    title: 'Knowledge base',
    blurb: 'Search, filter, and export the structured call records.',
  },
  {
    href: '/review',
    title: 'Review queue',
    blurb: 'Resolve the calls the pipeline held for a human decision.',
  },
  {
    href: '/notes',
    title: 'Technician notes',
    blurb: 'Read the note a technician would get, and say whether it is right.',
  },
];

const STYLE =
  THEME +
  `
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text); }
main { max-width: var(--content); margin: 0 auto; padding: 24px 16px 40px; }
.lead { font-size: 0.95rem; margin: 0 0 20px; }
/* Named .tiles/.tile, NOT .cards/.card: those two belong to the shared mobile card system in
   src/ui/cards.ts, where .cards is display:none outside a media query and .card is a
   collapsed-table row — entirely different semantics from this nav grid. The element qualifiers
   below would currently win on specificity, but that is luck, not a design: if this page ever
   imports CARD_STYLE, or someone drops the ul/a qualifiers, the grid would vanish below 900px. */
ul.tiles { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
a.tile { display: block; padding: 16px 18px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--panel); text-decoration: none; color: inherit; min-height: 44px;
  border-left: 3px solid var(--accent); }
a.tile:hover { background: var(--panel-3); border-color: var(--border-2); border-left-color: var(--accent); }
a.tile .title { display: block; font-weight: 600; font-size: 1.08rem; line-height: 1.3; color: var(--accent); }
a.tile .blurb { display: block; font-size: 0.9rem; line-height: 1.45; color: var(--muted); margin-top: 6px; }
.foot { margin-top: 28px; font-size: 0.8rem; color: var(--muted); }
`;

/** Render the self-contained home page. `csrfToken`/`nonce` wire Sign-out; absent → still renders. */
export function renderHome(opts: RenderHomeOptions = {}): string {
  const tiles = TILES.map(
    (c) =>
      `<li><a class="tile" href="${esc(c.href)}">` +
      `<span class="title">${esc(c.title)}</span>` +
      `<span class="blurb">${esc(c.blurb)}</span></a></li>`,
  ).join('');

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Call Insights — Console</title><style>${STYLE}</style></head><body>` +
    siteHeader('Home') +
    `<main>` +
    `<p class="lead muted">One sign-in for every screen. Pick where to go.</p>` +
    `<ul class="tiles">${tiles}</ul>` +
    `<p class="foot">Authorized internal use only. No customer content or personal data appears on this page.</p>` +
    `</main>` +
    logoutScript(opts) +
    `</body></html>`
  );
}
