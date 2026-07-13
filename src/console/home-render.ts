/**
 * The combined-console home page (single entry point). Self-contained HTML — inline CSS, one small
 * inline script for the CSRF'd logout, no external assets, no PII. It is pure navigation: one card
 * per internal surface so a signed-in user never has to type a path. Matches the dark palette the
 * status/review/knowledge surfaces already use.
 *
 * Logout is `POST /auth/logout`, which the shared middleware CSRF-protects via the `X-CSRF-Token`
 * HEADER — a plain `<form>` cannot set it — so the button uses the same embedded-token `fetch()`
 * idiom as the review surface.
 */

export interface RenderHomeOptions {
  /** The per-session CSRF token, embedded so the inline logout submitter can set the header. */
  csrfToken?: string;
  /** The per-request CSP script nonce; stamped on the inline `<script>` so it is allowed to run. */
  nonce?: string;
}

/** Escape the five HTML-significant characters. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string for safe embedding inside a `<script>` JSON literal. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\//g, '\\/');
}

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
];

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: 720px; margin: 0 auto; padding: 24px 16px 40px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; margin-bottom: 4px; }
h1 { font-size: 1.4rem; margin: 0; }
.sub { font-size: 0.9rem; opacity: 0.7; margin: 0 0 20px; }
ul.cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
a.card { display: block; padding: 16px; border-radius: 12px; border: 1px solid #2a323d;
  background: #161b22; text-decoration: none; color: inherit; min-height: 44px; }
a.card:hover { background: #1c2230; border-color: #3a4453; }
a.card .title { font-weight: 600; font-size: 1.05rem; color: #93c5fd; }
a.card .blurb { font-size: 0.9rem; opacity: 0.85; margin-top: 4px; }
button#logout { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #2a323d;
  background: #1a2029; color: #e7ecf2; cursor: pointer; min-height: 40px; }
button#logout:hover { background: #232b36; }
.foot { margin-top: 28px; font-size: 0.8rem; opacity: 0.65; }
`;

/** Render the self-contained home page. `csrfToken` wires the logout button; absent → still renders. */
export function renderHome(opts: RenderHomeOptions = {}): string {
  const cards = CARDS.map(
    (c) =>
      `<li><a class="card" href="${esc(c.href)}">` +
      `<span class="title">${esc(c.title)}</span>` +
      `<span class="blurb">${esc(c.blurb)}</span></a></li>`,
  ).join('');

  const logoutScript =
    `<script nonce="${esc(opts.nonce ?? '')}">` +
    `const CSRF=${jsonForScript(opts.csrfToken ?? '')};` +
    `document.getElementById('logout').addEventListener('click',async function(){` +
    `await fetch('/auth/logout',{method:'POST',headers:{'X-CSRF-Token':CSRF}});` +
    `window.location.href='/';});` +
    `</script>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Call Insights — Console</title><style>${STYLE}</style></head><body><main>` +
    `<header><h1>Call Insights</h1><button id="logout" type="button">Sign out</button></header>` +
    `<p class="sub">Internal console — one sign-in for every screen.</p>` +
    `<ul class="cards">${cards}</ul>` +
    `<p class="foot">Authorized internal use only. No customer content or personal data appears on this page.</p>` +
    `</main>${logoutScript}</body></html>`
  );
}
