import { CALL_INTENT, SERVICE_CATEGORIES, URGENCY } from '../db/enums.js';
import type { KnowledgeFilters, KnowledgeRecord, KnowledgeView } from './dto.js';
import { humanizeLabel } from './summary.js';
import { THEME, siteHeader, logoutScript, fmtTs, type Chrome } from '../ui/chrome.js';

/**
 * Server-rendered, self-contained knowledge page (Task 10.1). READ-ONLY: a GET `<form>` for the
 * filters, a summary block, a results table, and `export.csv`/`export.json` links that carry ONLY
 * the filter params (never `page`/`page_size` — Finding 2). Inline CSS, no external assets, no JS.
 * Every interpolated value is HTML-escaped; the DTO is already the allowlist, and each record has
 * passed the value-level egress guard before it reaches here.
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

/** A querystring built from the FILTER params only — never pagination. */
function filterQuery(filters: KnowledgeFilters): string {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.service_category) p.set('service_category', filters.service_category);
  if (filters.call_intent) p.set('call_intent', filters.call_intent);
  if (filters.urgency) p.set('urgency', filters.urgency);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** A `<select>` with an "any" option plus the enum values, humanized. */
function selectField(
  name: string,
  options: readonly string[],
  selected: string | undefined,
): string {
  const opts = [`<option value="">Any</option>`]
    .concat(
      options.map(
        (o) =>
          `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(humanizeLabel(o))}</option>`,
      ),
    )
    .join('');
  return `<label>${esc(name)}<select name="${esc(name)}">${opts}</select></label>`;
}

function cell(value: string | readonly string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) return esc(value.join('; '));
  return esc(String(value));
}

function rowHtml(r: KnowledgeRecord): string {
  return (
    `<tr>` +
    `<td class="mono" title="${esc(r.call_id)}">${esc(r.call_id)}</td>` +
    `<td class="mono" title="${esc(r.created_at)}">${esc(fmtTs(r.created_at))}</td>` +
    `<td>${esc(humanizeLabel(r.call_intent))}</td>` +
    `<td>${esc(humanizeLabel(r.service_category))}</td>` +
    `<td>${esc(humanizeLabel(r.urgency))}</td>` +
    `<td>${cell(r.problem_statement)}</td>` +
    `<td>${cell(r.symptoms)}</td>` +
    `<td>${cell(r.customer_language)}</td>` +
    `<td>${cell(r.concerns)}</td>` +
    `</tr>`
  );
}

/** Column sizing for the fixed-layout table: narrow, non-wrapping id/meta cols; free-text cols share the rest. */
const COLGROUP =
  `<colgroup><col class="c-id"><col class="c-time"><col class="c-intent">` +
  `<col class="c-cat"><col class="c-urg"><col><col><col><col></colgroup>`;

const STYLE =
  THEME +
  `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: var(--content-wide); margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 20px 0 8px; }
a { color: var(--accent); }
.nav { margin: 0 0 12px; font-size: 0.85rem; }
form.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; }
.filters-label { flex-basis: 100%; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--muted); }
form.filters label { display: flex; flex-direction: column; font-size: 0.78rem; gap: 3px; color: var(--muted); }
form.filters input, form.filters select { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg); color: var(--text); min-width: 150px; min-height: 40px; font: inherit; }
form.filters input:hover, form.filters select:hover { border-color: var(--border-2); }
form.filters button { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-3);
  color: var(--text); font-weight: 600; min-height: 40px; cursor: pointer; }
form.filters button:hover { background: var(--border); }
.summary { margin: 14px 0; padding: 12px 14px; border-radius: var(--radius); background: var(--panel-2);
  border: 1px solid var(--border); border-left: 3px solid var(--accent); }
.exports { margin: 8px 0 16px; }
.table-wrap { max-height: calc(100vh - 260px); border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
col.c-id { width: 116px; } col.c-time { width: 132px; } col.c-intent { width: 116px; }
col.c-cat { width: 128px; } col.c-urg { width: 92px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top;
  font-size: 0.85rem; word-break: break-word; overflow-wrap: anywhere; }
th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--muted);
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.03em; box-shadow: inset 0 -1px 0 var(--border); }
tbody tr:hover { background: var(--panel-2); }
.pager { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
.foot { margin-top: 24px; font-size: 0.8rem; color: var(--muted); }
`;

export function renderKnowledgePage(dto: KnowledgeView, chrome: Chrome = {}): string {
  const f = dto.filters;
  const qs = filterQuery(f);
  const csvHref = esc(`/knowledge/export.csv${qs}`);
  const jsonHref = esc(`/knowledge/export.json${qs}`);

  const form =
    `<form class="filters" method="get" action="/knowledge">` +
    `<span class="filters-label">Filters</span>` +
    `<label>Search<input type="text" name="q" value="${esc(f.q ?? '')}" placeholder="free text"></label>` +
    selectField('service_category', SERVICE_CATEGORIES, f.service_category) +
    selectField('call_intent', CALL_INTENT, f.call_intent) +
    selectField('urgency', URGENCY, f.urgency) +
    `<label>from<input type="text" name="from" value="${esc(f.from ?? '')}" placeholder="YYYY-MM-DD"></label>` +
    `<label>to<input type="text" name="to" value="${esc(f.to ?? '')}" placeholder="YYYY-MM-DD"></label>` +
    `<button type="submit">Search</button>` +
    `</form>`;

  const summaryBlock = `<div class="summary"><p>${esc(dto.summary.narrative)}</p></div>`;

  const exports = `<p class="exports">Export: <a href="${csvHref}">CSV</a> &middot; <a href="${jsonHref}">JSON</a></p>`;

  const header = `<tr>${[
    'Call',
    'Created',
    'Intent',
    'Category',
    'Urgency',
    'Problem',
    'Symptoms',
    'Customer language',
    'Concerns',
  ]
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr>`;
  const body = dto.results.map(rowHtml).join('');
  const table = `<div class="table-wrap table-scroll"><table>${COLGROUP}<thead>${header}</thead><tbody>${body}</tbody></table></div>`;

  const prevHref = dto.page > 1 ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page - 1}`) : '';
  const nextHref =
    dto.page < dto.total_pages ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page + 1}`) : '';
  const pager =
    `<div class="pager">` +
    (prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : '<span></span>') +
    `<span>Page ${esc(String(dto.page))} of ${esc(String(dto.total_pages))} · ${esc(String(dto.total))} total</span>` +
    (nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : '<span></span>') +
    `</div>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Knowledge base</title><style>${STYLE}</style></head><body>` +
    siteHeader('Knowledge base') +
    `<main>` +
    `<h1>Knowledge base</h1>` +
    form +
    summaryBlock +
    exports +
    pager +
    table +
    `<p class="foot">Read-only. De-identified records only.</p>` +
    `</main>` +
    logoutScript(chrome) +
    `</body></html>`
  );
}
