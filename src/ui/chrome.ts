/**
 * Shared UI chrome for the internal surfaces (design pass): design tokens (CSS variables), a
 * consistent site header with a working Sign-out, base focus/typography, and small label helpers.
 * Every surface's self-contained page prepends {@link THEME} and renders {@link siteHeader}, so the
 * console feels like ONE product and Sign-out is reachable from every screen. No external assets
 * (strict CSP): logout uses the per-request nonce'd inline script, the same pattern as the review
 * submitter. The header params are optional on read-only renders so existing unit calls still work;
 * a page without a nonce simply renders the button without its (harmless, unused) click script.
 */

/** Escape the five HTML-significant characters. Shared so surfaces stop re-declaring it. */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a string for safe embedding inside a `<script>` JSON literal. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\//g, '\\/');
}

/** Per-request tokens the shared logout control needs; both optional for read-only unit renders. */
export interface Chrome {
  /** Per-session CSRF token (the logout POST sets it as the `X-CSRF-Token` header). */
  csrfToken?: string;
  /** Per-request CSP script nonce (lets the logout inline script run). */
  nonce?: string;
}

/**
 * The shared token + base-style block. Additive only — it introduces CSS variables, focus states,
 * a `.muted` helper, and the `.site-header` component. It deliberately does NOT redefine `body`,
 * `a`, `button`, `.pill`, etc. that individual pages already style, so prepending it to a page's
 * existing `<style>` cannot conflict with that page's rules.
 */
export const THEME = `
:root {
  --bg: #0f1216; --panel: #161b22; --panel-2: #1a2029; --panel-3: #232b36;
  --border: #2a323d; --border-2: #3a4453;
  --text: #e7ecf2; --muted: #9aa7b4; --accent: #93c5fd;
  --ok-bg: #10391f; --ok-fg: #7ee2a8; --warn-bg: #3f3410; --warn-fg: #f5d67b;
  --bad-bg: #401a1a; --bad-fg: #f6a5a5; --info-bg: #22303f; --info-fg: #93c5fd;
  --radius: 12px;
  /* Shared content widths: reading pages use --content; table pages opt into --content-wide, so the
     width change between a form page and a table page reads as intentional, not accidental. */
  --content: 820px; --content-wide: 1140px;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.muted { color: var(--muted); }
/* Monospace, tabular, non-wrapping cell — for IDs and timestamps so columns scan cleanly. */
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 0.82em;
  overflow: hidden; text-overflow: ellipsis; }
/* Horizontal scroll container with edge shadows (the classic scroll-shadow) so users can SEE that
   more columns exist off-screen, plus a styled thin scrollbar. */
.table-scroll { overflow-x: auto; scrollbar-color: var(--border-2) transparent;
  background-image:
    linear-gradient(to right, var(--panel), rgba(22, 27, 34, 0)),
    linear-gradient(to left, var(--panel), rgba(22, 27, 34, 0)),
    radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0)),
    radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
  background-position: left center, right center, left center, right center;
  background-repeat: no-repeat;
  background-size: 28px 100%, 28px 100%, 14px 100%, 14px 100%;
  background-attachment: local, local, scroll, scroll; }
.table-scroll::-webkit-scrollbar { height: 10px; }
.table-scroll::-webkit-scrollbar-thumb { background: var(--border-2); border-radius: 6px; }
.site-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
.site-header .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 700;
  color: var(--text); text-decoration: none; letter-spacing: 0.01em; }
.site-header .brand .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--accent); }
.site-header .brand:hover { color: var(--accent); }
.site-header .section { color: var(--muted); font-size: 0.9rem; }
.site-header .section a { color: var(--accent); text-decoration: none; }
.site-header .section a:hover { text-decoration: underline; }
.site-header .section .sep { margin: 0 6px; color: var(--muted); }
.site-header .spacer { margin-left: auto; }
.site-header .signout { font: inherit; min-height: 38px; padding: 6px 14px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--text); cursor: pointer; }
.site-header .signout:hover { background: var(--panel-3); }
`;

/**
 * The consistent top bar: product mark (links home), a breadcrumb with an explicit **Home** link on
 * every inner page (the home page shows just "Home"), and a Sign-out button. Pair with
 * {@link logoutScript} once per page to wire the button.
 */
export function siteHeader(section: string): string {
  const crumb =
    section === 'Home'
      ? `<span class="section">Home</span>`
      : `<span class="section"><a href="/">Home</a><span class="sep">›</span>${esc(section)}</span>`;
  return (
    `<header class="site-header">` +
    `<a class="brand" href="/"><span class="dot"></span>Call Insights</a>` +
    crumb +
    `<span class="spacer"></span>` +
    `<button class="signout" id="signout" type="button">Sign out</button>` +
    `</header>`
  );
}

/**
 * The nonce'd inline script that wires Sign-out. It POSTs /auth/logout with the CSRF header (which
 * destroys the app session and returns `{ next }` — the IdP's logout URL when configured), then does
 * a TOP-LEVEL navigation to `next`. The top-level navigation is essential: only it lets the IdP
 * (Auth0) clear its own SSO cookie — a background fetch would leave SSO active and silently sign the
 * user right back in on the next page load.
 */
export function logoutScript(chrome: Chrome): string {
  return (
    `<script nonce="${esc(chrome.nonce ?? '')}">` +
    `var _so=document.getElementById('signout');` +
    `if(_so){_so.addEventListener('click',async function(){var next='/';` +
    `try{var r=await fetch('/auth/logout',{method:'POST',headers:{'X-CSRF-Token':${jsonForScript(
      chrome.csrfToken ?? '',
    )},'X-Requested-With':'xhr','Accept':'application/json'}});` +
    `var j=await r.json();if(j&&j.next){next=j.next;}}catch(e){}` +
    `window.location.href=next;});}` +
    `</script>`
  );
}

/** Compact a strict ISO-8601 timestamp to "YYYY-MM-DD HH:MM"; leaves any other string untouched. */
export function fmtTs(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** Plain-language names for the machine `held_reason` codes shown to reviewers. */
const REASON_LABELS: Record<string, string> = {
  classifier_uncertain: 'Classifier unsure',
  classified_spam: 'Looks like spam',
  malformed_model_output: 'Model output unreadable',
  schema_invalid: "Extraction didn't validate",
  redaction_failed: 'Redaction needs review',
  residual_pii_detected: 'Possible personal info remained',
  missing_transcript: 'Transcript missing',
  cost_cap_held: 'Paused for cost cap',
  weak_servicetitan_match: 'Weak ServiceTitan match',
  emergency_review: 'Emergency — needs a look',
};

/** Humanize a `held_reason` code; unknown codes fall back to a spaced form. */
export function humanizeReason(code: string): string {
  return REASON_LABELS[code] ?? code.replace(/_/g, ' ');
}
