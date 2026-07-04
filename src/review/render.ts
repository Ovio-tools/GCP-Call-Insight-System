import type { ReviewDetail, ReviewList } from './dto.js';

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

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: 720px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 20px 0 8px; }
a { color: #93c5fd; }
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

function slaPill(item: { sla_state: string }): string {
  return `<span class="pill sla-${esc(item.sla_state)}">${esc(item.sla_state.replace('_', ' '))}</span>`;
}

const HEAD = (title: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>`;

const FOOT = (generatedAt: string): string =>
  `<p class="foot">Generated at ${esc(generatedAt)}. <a href="/review">Back to queue</a></p>` +
  `</main></body></html>`;

export function renderReviewListPage(list: ReviewList): string {
  const rows =
    list.items.length === 0
      ? '<p>No calls are currently held for review.</p>'
      : `<ul class="items">${list.items
          .map(
            (i) =>
              `<li><a class="item" href="/review/${esc(i.id)}">` +
              `<span class="reason">${esc(i.held_reason)}</span>${slaPill(i)}` +
              `<div class="meta">${esc(i.explanation)}</div>` +
              `<div class="meta">status ${esc(i.status)} · held ${esc(i.created_at)}` +
              `${i.escalated ? ' · escalated' : ''}${i.raw_purged ? ' · raw purged' : ''}</div>` +
              `</a></li>`,
          )
          .join('')}</ul>`;
  return (
    HEAD('Review queue') +
    `<h1>Review queue</h1>` +
    `<p class="meta">${list.items.length} open item(s).</p>` +
    rows +
    FOOT(list.generated_at)
  );
}

export interface RenderDetailOptions {
  /** The per-session CSRF token, embedded so the inline submitter can set the header. */
  csrfToken: string;
  /** Whether the current session may reveal raw (renders the elevated button). */
  elevated: boolean;
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
  const actions = detail.allowed_actions;
  const btn = (action: string, label: string): string =>
    `<button data-action="${esc(action)}">${esc(label)}</button>`;
  const actionButtons = actions
    .filter((a) => a !== 'reprocess' && a !== 'correct_extraction')
    .map((a) => btn(a, a.replace(/_/g, ' ')))
    .join('');

  const revealButton =
    opts.elevated && detail.raw_available
      ? `<button id="reveal">reveal raw (elevated)</button>`
      : '';

  // The inline submitter: sets X-CSRF-Token from the embedded token. No external assets.
  const script =
    `<script>` +
    `const CSRF=${jsonForScript(opts.csrfToken)};const ID=${jsonForScript(detail.id)};` +
    `const out=document.getElementById('result');` +
    `async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','X-CSRF-Token':CSRF},body:JSON.stringify(body||{})});` +
    `out.textContent=r.status+' '+(await r.text());}` +
    `document.querySelectorAll('button[data-action]').forEach(function(b){b.onclick=function(){` +
    `post('/review/'+encodeURIComponent(ID)+'/actions/'+b.dataset.action,{});};});` +
    (revealButton
      ? `document.getElementById('reveal').onclick=function(){post('/review/'+encodeURIComponent(ID)+'/reveal-raw',{});};`
      : '') +
    `</script>`;

  return (
    HEAD(`Review ${detail.id}`) +
    `<h1>${esc(detail.held_reason)}</h1>${slaPill(detail)}` +
    `<p>${esc(detail.explanation)}</p>` +
    `<div class="meta">call ${esc(detail.call_id)} · status ${esc(detail.status)} · ` +
    `assignee ${esc(detail.assignee ?? 'unassigned')} · raw ${detail.raw_available ? 'available' : 'unavailable'}</div>` +
    `<h2>Redacted content</h2>${content}` +
    enums +
    `<h2>Actions</h2><div>${actionButtons}${revealButton}</div>` +
    `<div id="result" aria-live="polite"></div>` +
    script +
    FOOT(detail.created_at)
  );
}
