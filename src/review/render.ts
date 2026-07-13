import type { ReviewDetail, ReviewList } from './dto.js';
import { THEME, siteHeader, logoutScript, humanizeReason, type Chrome } from '../ui/chrome.js';

/**
 * Server-rendered, self-contained review pages (Task 6.2). READ-ONLY HTML: the shared middleware
 * checks the `X-CSRF-Token` HEADER, which a plain `<form>` cannot set, so every state-changing
 * call is a JSON `fetch()` that sets the header from an embedded per-session CSRF token. Inline
 * CSS, no external assets, no PII — the DTO is already the allowlist and every value is escaped.
 * Mobile-first, single column.
 */

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

const STYLE =
  THEME +
  `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: 720px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 20px 0 8px; }
a { color: #93c5fd; }
.nav { margin: 4px 0 12px; font-size: 0.85rem; }
ul.items { list-style: none; padding: 0; margin: 0; }
.item { display: block; padding: 12px; margin: 8px 0; border-radius: 10px; border: 1px solid #2a323d;
  background: #161b22; text-decoration: none; color: inherit; }
.item .reason { font-weight: 600; }
.pill { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; padding: 2px 8px;
  border-radius: 999px; margin-left: 6px; }
.sla-ok { background: #10391f; color: #7ee2a8; }
.sla-due_soon { background: #3f3410; color: #f5d67b; }
.sla-breached { background: #401a1a; color: #f6a5a5; }
.meta { font-size: 0.85rem; opacity: 0.8; }
pre.redacted { white-space: pre-wrap; word-break: break-word; background: #12171e; padding: 12px;
  border-radius: 8px; border: 1px solid #2a323d; }
.withheld { font-style: italic; opacity: 0.8; }
button { font: inherit; padding: 10px 14px; margin: 4px 6px 4px 0; border-radius: 8px;
  border: 1px solid #2a323d; background: #1a2029; color: #e7ecf2; cursor: pointer; min-height: 44px; }
button:hover { background: #232b36; }
#result { margin-top: 12px; font-size: 0.9rem; }
.foot { margin-top: 24px; font-size: 0.8rem; opacity: 0.7; }
`;

/** Plain-language SLA wording. "Overdue" reads clearer and less alarming than "breached". */
const SLA_LABEL: Record<string, string> = {
  ok: 'On time',
  due_soon: 'Due soon',
  breached: 'Overdue',
};

function slaPill(item: { sla_state: string }): string {
  const label = SLA_LABEL[item.sla_state] ?? item.sla_state.replace('_', ' ');
  return `<span class="pill sla-${esc(item.sla_state)}">${esc(label)}</span>`;
}

const HEAD = (title: string, section: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${esc(title)}</title><style>${STYLE}</style></head><body>` +
  siteHeader(section) +
  `<main>`;

const FOOT = (generatedAt: string, chrome: Chrome): string =>
  `<p class="foot">Generated at ${esc(generatedAt)}. <a href="/review">Back to queue</a></p>` +
  `</main>` +
  logoutScript(chrome) +
  `</body></html>`;

export function renderReviewListPage(list: ReviewList, chrome: Chrome = {}): string {
  const rows =
    list.items.length === 0
      ? '<p>No calls are currently held for review.</p>'
      : `<ul class="items">${list.items
          .map(
            (i) =>
              `<li><a class="item" href="/review/${esc(i.id)}">` +
              `<span class="reason">${esc(humanizeReason(i.held_reason))}</span>${slaPill(i)}` +
              `<div class="meta">${esc(i.explanation)}</div>` +
              `<div class="meta">status ${esc(i.status)} · held ${esc(i.created_at)}` +
              `${i.escalated ? ' · escalated' : ''}${i.raw_purged ? ' · raw purged' : ''}</div>` +
              `</a></li>`,
          )
          .join('')}</ul>`;
  return (
    HEAD('Review queue', 'Review queue') +
    `<h1>Review queue</h1>` +
    `<p class="meta">${list.items.length} call(s) waiting for a decision.</p>` +
    rows +
    FOOT(list.generated_at, chrome)
  );
}

export interface RenderDetailOptions {
  /** The per-session CSRF token, embedded so the inline submitter can set the header. */
  csrfToken: string;
  /** Whether the current session may reveal raw (renders the elevated button). */
  elevated: boolean;
  /** The per-request CSP script nonce; stamped on the inline `<script>` so it is allowed to run. */
  nonce: string;
}

export function renderReviewDetailPage(detail: ReviewDetail, opts: RenderDetailOptions): string {
  const content = detail.redacted_content_available
    ? `<pre class="redacted">${esc(detail.redacted_content ?? '')}</pre>`
    : `<p class="withheld">Redacted content unavailable (${esc(
        detail.redacted_content_withheld_reason ?? 'unavailable',
      )}).</p>`;

  const enums = detail.extracted
    ? `<h2>Extracted (enums only)</h2><div class="meta">intent ${esc(detail.extracted.call_intent)} · ` +
      `category ${esc(detail.extracted.service_category)} · urgency ${esc(detail.extracted.urgency)} · ` +
      `sentiment ${esc(detail.extracted.sentiment)}</div>`
    : '';

  // Action buttons: reprocess/approve/correct_extraction/terminal actions all POST JSON with the
  // CSRF header. correct_extraction needs the four enum <select>s; reprocess needs a stage select.
  // Plain-language labels + a hover tooltip so a reviewer isn't decoding raw action codes.
  const actions = detail.allowed_actions;
  const ACTION_LABELS: Record<string, { label: string; title: string }> = {
    approve: {
      label: 'Customer call',
      title: 'Approve: treat as a genuine customer call and continue processing',
    },
    mark_non_customer: {
      label: 'Non-customer call',
      title: 'Mark as a non-customer call (internal, wrong number, etc.)',
    },
    mark_spam: { label: 'Spam', title: 'Mark as spam or a robocall' },
    reject: { label: 'Discard', title: 'Reject and discard this call' },
    mark_unresolvable: {
      label: "Can't resolve",
      title: 'Mark as unresolvable — keep for the record, no further action',
    },
  };
  const btn = (action: string): string => {
    const meta = ACTION_LABELS[action] ?? { label: action.replace(/_/g, ' '), title: action };
    return `<button data-action="${esc(action)}" title="${esc(meta.title)}">${esc(
      meta.label,
    )}</button>`;
  };
  const actionButtons = actions
    .filter((a) => a !== 'reprocess' && a !== 'correct_extraction')
    .map(btn)
    .join('');

  const revealButton =
    opts.elevated && detail.raw_available
      ? `<button id="reveal" title="Show the original transcript (recorded, elevated access only)">Reveal original transcript</button>`
      : '';

  // The inline submitter: sets X-CSRF-Token from the embedded token. No external assets. The
  // per-request CSP nonce lets this inline script run under `script-src 'self' 'nonce-…'`. A resolve
  // action returns to the queue on success; reveal shows the returned content in place. Errors read
  // in plain language instead of a raw HTTP status + JSON body.
  const script =
    `<script nonce="${esc(opts.nonce)}">` +
    `const CSRF=${jsonForScript(opts.csrfToken)};const ID=${jsonForScript(detail.id)};` +
    `const out=document.getElementById('result');` +
    `function call(url){return fetch(url,{method:'POST',headers:{'content-type':'application/json','X-CSRF-Token':CSRF},body:'{}'});}` +
    `document.querySelectorAll('button[data-action]').forEach(function(b){b.addEventListener('click',async function(){` +
    `b.disabled=true;out.textContent='Working…';` +
    `var r=await call('/review/'+encodeURIComponent(ID)+'/actions/'+b.dataset.action);` +
    `if(r.ok){out.textContent='Done — returning to the queue…';setTimeout(function(){location.href='/review';},900);}` +
    `else{b.disabled=false;out.textContent='Could not complete that action (error '+r.status+'). Please try again.';}` +
    `});});` +
    (revealButton
      ? `document.getElementById('reveal').addEventListener('click',async function(){out.textContent='Revealing…';var r=await call('/review/'+encodeURIComponent(ID)+'/reveal-raw');out.textContent=(r.ok?await r.text():'Reveal failed (error '+r.status+').');});`
      : '') +
    `</script>`;

  return (
    HEAD(`Review ${detail.id}`, 'Review') +
    `<p class="nav"><a href="/review">&larr; Review queue</a></p>` +
    `<h1>${esc(humanizeReason(detail.held_reason))}</h1>${slaPill(detail)}` +
    `<p>${esc(detail.explanation)}</p>` +
    `<div class="meta">call ${esc(detail.call_id)} · status ${esc(detail.status)} · ` +
    `assignee ${esc(detail.assignee ?? 'unassigned')} · raw ${detail.raw_available ? 'available' : 'unavailable'}</div>` +
    `<h2>Redacted content</h2>${content}` +
    enums +
    `<h2>Resolve this call</h2>` +
    `<p class="meta">Choose what this call is. Your choice is recorded and closes the review.</p>` +
    `<div>${actionButtons}${revealButton}</div>` +
    `<div id="result" aria-live="polite"></div>` +
    script +
    FOOT(detail.created_at, opts)
  );
}
