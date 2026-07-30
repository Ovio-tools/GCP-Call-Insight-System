import {
  OUTCOME_FILTERS,
  type CallListItem,
  type CallOutcomeKey,
  type CallsPage,
} from './calls.js';
import { THEME, siteHeader, logoutScript, fmtTs, type Chrome } from '../ui/chrome.js';
import { CARD_STYLE, cardField } from '../ui/cards.js';

/**
 * Server-rendered, self-contained per-call pipeline page (companion to /status). READ-ONLY:
 * a GET filter form, an outcome-badged table, and a pager. Inline CSS, no external assets, no
 * JS. Every interpolated value is HTML-escaped; the DTO carries only ids, enums, and timestamps
 * (no content/PII — see calls.ts).
 */

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanizeStage(stage: string): string {
  const spaced = stage.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Badge accent colour per outcome so the table scans at a glance. */
const BADGE_COLOR: Record<CallOutcomeKey, string> = {
  customer_completed: '#1f7a4d',
  non_customer: '#5a4b7a',
  spam: '#7a4b4b',
  filtered: '#4b566a',
  held: '#7a6a3a',
  review_closed: '#3a5a6a',
  processing: '#3a4a5a',
};

function badge(item: CallListItem): string {
  const color = BADGE_COLOR[item.outcome.key];
  return `<span class="badge" style="background:${color}">${esc(item.outcome.label)}</span>`;
}

function rowHtml(item: CallListItem): string {
  return (
    `<tr>` +
    `<td class="mono" title="${esc(item.call_id)}">${esc(item.call_id)}</td>` +
    `<td class="mono" title="${esc(item.created_at)}">${esc(fmtTs(item.created_at))}</td>` +
    `<td>${badge(item)}</td>` +
    `<td>${esc(item.outcome.reason ?? '')}</td>` +
    `<td>${esc(humanizeStage(item.current_stage))}</td>` +
    `<td class="mono" title="${esc(item.updated_at)}">${esc(fmtTs(item.updated_at))}</td>` +
    `</tr>`
  );
}

/**
 * One call as a mobile card. Flat — every field visible, no expander: with six short fields
 * (an id, two timestamps, an enum badge, a short reason, a stage) a disclosure control would hide
 * almost nothing while costing a tap. `Updated` appears ONLY when it differs from `Created`, so
 * its presence carries information rather than restating the line above it.
 */
function cardHtml(item: CallListItem): string {
  const reason = item.outcome.reason?.trim()
    ? `<p class="card-meta">${esc(item.outcome.reason)}</p>`
    : '';
  const fields =
    cardField('Stage', humanizeStage(item.current_stage)) +
    (item.updated_at !== item.created_at ? cardField('Updated', fmtTs(item.updated_at)) : '') +
    `<div class="field"><dt>Call</dt>` +
    `<dd class="mono" title="${esc(item.call_id)}">${esc(item.call_id)}</dd></div>`;

  // Identifying, not a bare timestamp the <time> element right below would only repeat.
  const cardLabel = `${item.outcome.label} call, ${fmtTs(item.created_at)}`;

  return (
    `<article class="card" aria-label="${esc(cardLabel)}">` +
    `<div class="card-head">` +
    `<time datetime="${esc(item.created_at)}">${esc(fmtTs(item.created_at))}</time>` +
    `${badge(item)}</div>` +
    reason +
    `<dl class="fields">${fields}</dl>` +
    `</article>`
  );
}

/** Column sizing for the fixed-layout table: narrow non-wrapping id/time cols; text cols share the rest. */
const COLGROUP =
  `<colgroup><col class="c-id"><col class="c-time"><col class="c-outcome">` +
  `<col><col class="c-stage"><col class="c-time"></colgroup>`;

const STYLE =
  THEME +
  `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: var(--content-wide); margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
a { color: var(--accent); }
.nav { margin: 0 0 12px; font-size: 0.85rem; }
form.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.filters-label { flex-basis: 100%; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted); }
form.filters label { display: flex; flex-direction: column; font-size: 0.78rem; gap: 3px; color: var(--muted); }
form.filters select { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); min-width: 200px; min-height: 40px; font: inherit; }
form.filters button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-3);
  color: var(--text); font-weight: 600; min-height: 40px; cursor: pointer; }
form.filters button:hover { background: var(--border); }
.table-wrap { max-height: calc(100vh - 260px); margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
col.c-id { width: 116px; } col.c-time { width: 132px; } col.c-outcome { width: 132px; } col.c-stage { width: 150px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top;
  font-size: 0.85rem; word-break: break-word; overflow-wrap: anywhere; }
th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--muted);
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.03em; box-shadow: inset 0 -1px 0 var(--border); }
tbody tr:hover { background: var(--panel-2); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem;
  font-weight: 600; color: #eef2f7; white-space: nowrap; }
.pager { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
.foot { margin-top: 24px; font-size: 0.8rem; color: var(--muted); }
` +
  // After this page's own base rules, per CARD_STYLE's documented placement contract: it may only
  // override rules declared before it, and the page adds no media query of its own.
  CARD_STYLE;

export function renderCallsPage(dto: CallsPage, chrome: Chrome = {}): string {
  const qs = dto.filter && dto.filter !== 'all' ? `?outcome=${encodeURIComponent(dto.filter)}` : '';

  const options = OUTCOME_FILTERS.map(
    (f) =>
      `<option value="${esc(f.key)}"${f.key === dto.filter ? ' selected' : ''}>${esc(f.label)}</option>`,
  ).join('');
  const form =
    `<form class="filters" method="get" action="/calls">` +
    `<span class="filters-label">Filters</span>` +
    `<label>Outcome<select name="outcome">${options}</select></label>` +
    `<button type="submit">Filter</button>` +
    `</form>`;

  const header = `<tr>${['Call', 'Created', 'Outcome', 'Reason', 'Stage', 'Updated']
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr>`;
  const body =
    dto.items.length > 0
      ? dto.items.map(rowHtml).join('')
      : `<tr><td colspan="6">No calls match this filter yet.</td></tr>`;
  const table = `<div class="table-wrap table-scroll"><table>${COLGROUP}<thead>${header}</thead><tbody>${body}</tbody></table></div>`;

  const cards =
    `<div class="cards">` +
    (dto.items.length > 0
      ? dto.items.map(cardHtml).join('')
      : `<p class="muted">No calls match this filter yet.</p>`) +
    `</div>`;

  const prevHref = dto.page > 1 ? esc(`/calls${qs ? `${qs}&` : '?'}page=${dto.page - 1}`) : '';
  const nextHref =
    dto.page < dto.total_pages ? esc(`/calls${qs ? `${qs}&` : '?'}page=${dto.page + 1}`) : '';
  const pager =
    `<div class="pager">` +
    (prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : '<span></span>') +
    `<span>Page ${esc(String(dto.page))} of ${esc(String(dto.total_pages))} · ${esc(String(dto.total))} total</span>` +
    (nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : '<span></span>') +
    `</div>`;
  // Mobile-only duplicate below the results, so paging does not mean scrolling back up. CARD_STYLE
  // hides `.pager.pager-bottom` at desktop widths.
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager pager-bottom">');

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Calls</title><style>${STYLE}</style></head><body>` +
    siteHeader('All calls') +
    `<main>` +
    `<p class="nav"><a href="/status">&larr; Pipeline health</a></p>` +
    `<h1>Calls — full pipeline</h1>` +
    form +
    pager +
    table +
    cards +
    pagerBottom +
    `<p class="foot">Read-only. Call outcomes only — no transcript content or PII.</p>` +
    `</main>` +
    logoutScript(chrome) +
    `</body></html>`
  );
}
