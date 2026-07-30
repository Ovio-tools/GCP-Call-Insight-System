import { THEME, esc, siteHeader, logoutScript, type Chrome } from '../ui/chrome.js';

/**
 * The combined-console home page (single entry point). Self-contained HTML — the shared {@link THEME}
 * tokens + a small page-specific card grid, the shared {@link siteHeader} (with a working Sign-out),
 * and one nonce'd inline script. Pure navigation: one card per internal surface so a signed-in user
 * never has to type a path.
 */

export type RenderHomeOptions = Chrome;

interface SurfaceCard {
  href: string;
  title: string;
  blurb: string;
}

/** The surfaces the combined console mounts, in the order a person is most likely to want them. */
const CARDS: readonly SurfaceCard[] = [
  {
    href: '/status',
    title: 'Pipeline health',
    blurb:
      'Is the system running, and where are calls right now? Health for each step, ' +
      "today's totals, and spend against budget. No call content.",
  },
  {
    href: '/calls',
    title: 'All calls',
    blurb:
      'Every call that came in and what happened to it — finished, skipped as too ' +
      'short or not a conversation, waiting for review, or failed.',
  },
  {
    href: '/knowledge',
    title: 'Knowledge base',
    blurb:
      'The finished records: what each customer wanted, how urgent it was, and their ' +
      'own words. Search, filter, and export to CSV or JSON.',
  },
  {
    href: '/review',
    title: 'Review queue',
    blurb:
      "Calls the system paused because it wasn't sure. Read the anonymised text, say " +
      'what the call was, and it finishes processing.',
  },
];

const STYLE =
  THEME +
  `
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text); }
main { max-width: var(--content); margin: 0 auto; padding: 24px 16px 40px; }
h1 { font-size: 1.5rem; margin: 0 0 10px; }
.lead { font-size: 0.95rem; line-height: 1.6; max-width: 68ch; margin: 0 0 24px; color: var(--muted); }
ul.cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
a.card { display: block; padding: 16px 18px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--panel); text-decoration: none; color: inherit; min-height: 44px;
  border-left: 3px solid var(--accent); }
a.card:hover { background: var(--panel-3); border-color: var(--border-2); border-left-color: var(--accent); }
a.card .title { display: block; font-weight: 600; font-size: 1.08rem; line-height: 1.3; color: var(--accent); }
a.card .blurb { display: block; font-size: 0.9rem; line-height: 1.45; color: var(--muted); margin-top: 6px; }
.foot { margin-top: 28px; font-size: 0.8rem; color: var(--muted); }
`;

/** Render the self-contained home page. `csrfToken`/`nonce` wire Sign-out; absent → still renders. */
export function renderHome(opts: RenderHomeOptions = {}): string {
  const cards = CARDS.map(
    (c) =>
      `<li><a class="card" href="${esc(c.href)}">` +
      `<span class="title">${esc(c.title)}</span>` +
      `<span class="blurb">${esc(c.blurb)}</span></a></li>`,
  ).join('');

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Call Insights — Console</title><style>${STYLE}</style></head><body>` +
    siteHeader('Home') +
    `<main>` +
    `<h1>Call Insights</h1>` +
    `<p class="lead">` +
    `Every phone call that comes in is picked up automatically, stripped of names, numbers and ` +
    `addresses, and turned into a short written record of what the customer actually asked for — ` +
    `the problem, how urgent it is, and the words they used. Those records build up into a ` +
    `searchable history you can filter and export. Anything the system isn't confident about is ` +
    `set aside for a person instead of guessed at. One sign-in covers every screen below.` +
    `</p>` +
    `<ul class="cards">${cards}</ul>` +
    `<p class="foot">Authorized internal use only. No customer content or personal data appears on this page.</p>` +
    `</main>` +
    logoutScript(opts) +
    `</body></html>`
  );
}
