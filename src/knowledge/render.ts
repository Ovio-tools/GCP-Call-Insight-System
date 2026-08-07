import { CALL_INTENT, SERVICE_CATEGORIES, URGENCY, type Urgency } from '../db/enums.js';
import type { KnowledgeFilters, KnowledgeRecord, KnowledgeView } from './dto.js';
import { humanizeLabel } from './summary.js';
import { THEME, siteHeader, logoutScript, type Chrome } from '../ui/chrome.js';
import { CARD_STYLE, cardField } from '../ui/cards.js';

/**
 * Formatter for the `Created` column: renders a UTC ISO timestamp in US Central Time
 * (America/Chicago — CST/CDT handled automatically) as `MM-DD-YYYY HH:MM:SS`, 24-hour clock.
 */
const CENTRAL_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Format a strict ISO-8601 timestamp as `MM-DD-YYYY HH:MM:SS CT`; leaves any unparseable string
 * untouched. Exported for the note-review surface, which shows the SAME call date on its own
 * screens — one call must not read as two different times depending on which page you opened, the
 * same reason `src/notes/query.ts` imports this surface's date-bound parser rather than copying it. */
export function fmtCreatedCt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts: Record<string, string> = {};
  for (const p of CENTRAL_TIME_FORMAT.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.month}-${parts.day}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second} CT`;
}

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

/** How many filters the user actually set — drives the mobile summary bar's label and open state. */
function activeFilterCount(filters: KnowledgeFilters): number {
  return [
    filters.q,
    filters.service_category,
    filters.call_intent,
    filters.urgency,
    filters.from,
    filters.to,
  ].filter((v) => v !== undefined && v !== '').length;
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
    `<td class="mono" title="${esc(r.created_at)}">${esc(fmtCreatedCt(r.created_at))}</td>` +
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

/** Urgency → theme-token pill class, built once from the `Urgency` union so the compiler enforces
 *  that every enum member has a mapping (`satisfies Record<Urgency, string>`). The `.get` fallback
 *  stays as a runtime safety net for a row written under a schema version before a mapping existed
 *  — not because the map itself is partial. */
const URGENCY_PILL = new Map<string, string>(
  Object.entries({
    emergency: 'u-emergency',
    urgent: 'u-urgent',
    routine: 'u-routine',
  } satisfies Record<Urgency, string>),
);

function urgencyPill(urgency: string): string {
  const cls = URGENCY_PILL.get(urgency) ?? 'u-other';
  return `<span class="kb-urgency ${cls}">${esc(humanizeLabel(urgency))}</span>`;
}

/**
 * One record as a mobile card: a collapsed summary (time, urgency, category/intent, problem) plus a
 * native `<details>` expander carrying everything else — including the five fields the desktop table
 * has no column for. When every expandable field is empty the expander is omitted entirely and the
 * call id falls back to a plain line, so no card offers a "More details" that reveals nothing.
 */
function cardHtml(r: KnowledgeRecord): string {
  const blocks =
    cardField('Symptoms', r.symptoms) +
    cardField('They said', r.customer_language) +
    cardField('Concerns', r.concerns) +
    cardField('Where in the home', r.location_in_home) +
    cardField('Access / scheduling', r.access_or_scheduling_notes) +
    cardField('Already tried', r.prior_attempts) +
    cardField('Competitors mentioned', r.competitor_mentions) +
    cardField('Heard about us via', r.acquisition_source);

  const callIdField =
    `<div class="field"><dt>Call</dt>` +
    `<dd class="mono" title="${esc(r.call_id)}">${esc(r.call_id)}</dd></div>`;
  const more = blocks
    ? `<details class="kb-more"><summary>More details</summary>` +
      `<dl class="fields">${blocks}${callIdField}</dl></details>`
    : `<p class="callid mono" title="${esc(r.call_id)}">${esc(r.call_id)}</p>`;

  const problem = r.problem_statement?.trim()
    ? `<p class="kb-problem">${esc(r.problem_statement)}</p>`
    : `<p class="kb-problem kb-empty">No problem statement recorded.</p>`;

  // Identifying, not a bare timestamp the <time> element right below it would only repeat: a
  // screen reader landing on the card by article role hears what call it is before anything else.
  const cardLabel =
    `${humanizeLabel(r.urgency)} ${humanizeLabel(r.service_category)} call, ` +
    fmtCreatedCt(r.created_at);

  return (
    `<article class="card" aria-label="${esc(cardLabel)}">` +
    `<div class="card-head"><time datetime="${esc(r.created_at)}">${esc(fmtCreatedCt(r.created_at))}</time>` +
    `${urgencyPill(r.urgency)}</div>` +
    `<p class="card-meta">${esc(humanizeLabel(r.service_category))} &middot; ` +
    `${esc(humanizeLabel(r.call_intent))}</p>` +
    problem +
    more +
    `</article>`
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
col.c-id { width: 116px; } col.c-time { width: 176px; } col.c-intent { width: 116px; }
col.c-cat { width: 128px; } col.c-urg { width: 92px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top;
  font-size: 0.85rem; word-break: break-word; overflow-wrap: anywhere; }
th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--muted);
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.03em; box-shadow: inset 0 -1px 0 var(--border); }
tbody tr:hover { background: var(--panel-2); }
.pager { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
.foot { margin-top: 24px; font-size: 0.8rem; color: var(--muted); }
` +
  CARD_STYLE +
  `
/* ---- Knowledge-specific card and filter chrome, on top of the shared card system above. ---- */
.kb-urgency { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px;
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  white-space: nowrap; }
.kb-urgency.u-emergency { background: var(--bad-bg); color: var(--bad-fg); }
.kb-urgency.u-urgent { background: var(--warn-bg); color: var(--warn-fg); }
.kb-urgency.u-routine { background: var(--ok-bg); color: var(--ok-fg); }
.kb-urgency.u-other { background: var(--panel-3); color: var(--muted); }
.kb-problem { margin: 8px 0 0; font-size: 0.95rem; overflow-wrap: break-word; }
.kb-problem.kb-empty { color: var(--muted); font-style: italic; }
.kb-more { margin: 10px 0 0; border-top: 1px solid var(--border); padding-top: 4px; }
.kb-more > summary { cursor: pointer; min-height: 44px; padding: 12px 0; display: list-item;
  list-style-position: inside; color: var(--accent); font-size: 0.85rem; }
.kb-filters-mobile { display: none; }
.kb-filters-mobile > summary { cursor: pointer; min-height: 44px; padding: 12px 14px;
  display: list-item; list-style-position: inside; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius); font-weight: 600;
  font-size: 0.9rem; }
.kb-filters-mobile[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
/* ---- The knowledge page's OWN mobile block. A second @media with the same query is intentional:
   the shared one above already stacks the table into cards and makes the generic form controls
   full-width and 44px tall, and this one comes later so its page-specific rules win where the two
   overlap. Only decisions that carry a knowledge-page assumption live here. ---- */
@media (max-width: 899px) {
  .kb-filters-desktop { display: none; }
  .kb-filters-mobile { display: block; }
  /* Scoped under .kb-filters-mobile because it assumes the form is the one embedded in the mobile
     disclosure, not any other use of form.filters: border-top: 0 plus the two zeroed top radii
     assume an attached summary bar directly above (pairing with the [open] rule that squares off
     the summary's own bottom corners, so the bar and form read as one continuous panel). The
     generic stacking/sizing this rule used to also carry now comes from the shared block. */
  .kb-filters-mobile form.filters { border-top: 0;
    border-top-left-radius: 0; border-top-right-radius: 0; }
  /* Likewise an assumption, not a generic: the summary bar already said "Filters" right above. */
  .kb-filters-mobile .filters-label { display: none; }
  .exports { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
}
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

  const activeCount = activeFilterCount(f);
  const filtersSummary =
    activeCount === 0 ? 'Filters' : `Filters &middot; ${esc(String(activeCount))} active`;
  const filtersBlock =
    `<div class="kb-filters-desktop">${form}</div>` +
    `<details class="kb-filters-mobile"${activeCount > 0 ? ' open' : ''}>` +
    `<summary>${filtersSummary}</summary>${form}</details>`;

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
  const cards = `<div class="cards">${dto.results.map(cardHtml).join('')}</div>`;

  const prevHref = dto.page > 1 ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page - 1}`) : '';
  const nextHref =
    dto.page < dto.total_pages ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page + 1}`) : '';
  const pager =
    `<div class="pager">` +
    (prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : '<span></span>') +
    `<span>Page ${esc(String(dto.page))} of ${esc(String(dto.total_pages))} · ${esc(String(dto.total))} total</span>` +
    (nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : '<span></span>') +
    `</div>`;
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager pager-bottom">');

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Knowledge base</title><style>${STYLE}</style></head><body>` +
    siteHeader('Knowledge base') +
    `<main>` +
    `<h1>Knowledge base</h1>` +
    filtersBlock +
    summaryBlock +
    exports +
    pager +
    table +
    cards +
    pagerBottom +
    `<p class="foot">Read-only. De-identified records only.</p>` +
    `</main>` +
    logoutScript(chrome) +
    `</body></html>`
  );
}
