import { CALL_INTENT, SERVICE_CATEGORIES, URGENCY, type Urgency } from '../db/enums.js';
import type { KnowledgeFilters, KnowledgeRecord, KnowledgeView } from './dto.js';
import { humanizeLabel } from './summary.js';
import { THEME, siteHeader, logoutScript, pageIntro, type Chrome } from '../ui/chrome.js';

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

/** Format a strict ISO-8601 timestamp as `MM-DD-YYYY HH:MM:SS CT`; leaves any unparseable string untouched. */
function fmtCreatedCt(iso: string): string {
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

/** One labelled block inside a card's expander. Returns '' for a null scalar, a blank or
 *  whitespace-only string, or an array with no non-blank elements, so an absent (or
 *  effectively-absent) field never costs a blank row or an empty chip. */
function detailBlock(label: string, value: string | readonly string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) {
    // Re-typed explicitly: `Array.isArray` narrowing a `readonly string[] | string` union leaves
    // TS unable to resolve element types on further chaining (`.filter`/`.map`), same gotcha noted
    // for `cell()` above — an explicit annotation, not a cast, restores a clean `readonly string[]`.
    const arr: readonly string[] = value;
    const populated = arr.filter((v) => v.trim().length > 0);
    if (populated.length === 0) return '';
    const chips = populated.map((v) => `<span class="kb-chip">${esc(v)}</span>`).join('');
    return `<div class="kb-field"><dt>${esc(label)}</dt><dd>${chips}</dd></div>`;
  }
  const text = String(value);
  if (text.trim().length === 0) return '';
  return `<div class="kb-field"><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`;
}

/**
 * One record as a mobile card: a collapsed summary (time, urgency, category/intent, problem) plus a
 * native `<details>` expander carrying everything else — including the five fields the desktop table
 * has no column for. When every expandable field is empty the expander is omitted entirely and the
 * call id falls back to a plain line, so no card offers a "More details" that reveals nothing.
 */
function cardHtml(r: KnowledgeRecord): string {
  const blocks =
    detailBlock('Symptoms', r.symptoms) +
    detailBlock('They said', r.customer_language) +
    detailBlock('Concerns', r.concerns) +
    detailBlock('Where in the home', r.location_in_home) +
    detailBlock('Access / scheduling', r.access_or_scheduling_notes) +
    detailBlock('Already tried', r.prior_attempts) +
    detailBlock('Competitors mentioned', r.competitor_mentions) +
    detailBlock('Heard about us via', r.acquisition_source);

  const callIdField =
    `<div class="kb-field"><dt>Call</dt>` +
    `<dd class="mono" title="${esc(r.call_id)}">${esc(r.call_id)}</dd></div>`;
  const more = blocks
    ? `<details class="kb-more"><summary>More details</summary>` +
      `<dl class="kb-fields">${blocks}${callIdField}</dl></details>`
    : `<p class="kb-callid mono" title="${esc(r.call_id)}">${esc(r.call_id)}</p>`;

  const problem = r.problem_statement?.trim()
    ? `<p class="kb-problem">${esc(r.problem_statement)}</p>`
    : `<p class="kb-problem kb-empty">No problem statement recorded.</p>`;

  // Identifying, not a bare timestamp the <time> element right below it would only repeat: a
  // screen reader landing on the card by article role hears what call it is before anything else.
  const cardLabel =
    `${humanizeLabel(r.urgency)} ${humanizeLabel(r.service_category)} call, ` +
    fmtCreatedCt(r.created_at);

  return (
    `<article class="kb-card" aria-label="${esc(cardLabel)}">` +
    `<div class="kb-card-head"><time datetime="${esc(r.created_at)}">${esc(fmtCreatedCt(r.created_at))}</time>` +
    `${urgencyPill(r.urgency)}</div>` +
    `<p class="kb-meta">${esc(humanizeLabel(r.service_category))} &middot; ` +
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
/* ---- Mobile card list. Hidden at desktop widths; the media query in Task 2 reveals it. ---- */
.kb-cards { display: none; }
.kb-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; margin: 0 0 12px; }
.kb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kb-card-head time { color: var(--muted); font-size: 0.78rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.kb-urgency { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px;
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  white-space: nowrap; }
.kb-urgency.u-emergency { background: var(--bad-bg); color: var(--bad-fg); }
.kb-urgency.u-urgent { background: var(--warn-bg); color: var(--warn-fg); }
.kb-urgency.u-routine { background: var(--ok-bg); color: var(--ok-fg); }
.kb-urgency.u-other { background: var(--panel-3); color: var(--muted); }
.kb-meta { margin: 8px 0 0; font-weight: 600; font-size: 0.95rem; }
.kb-problem { margin: 8px 0 0; font-size: 0.95rem; overflow-wrap: break-word; }
.kb-problem.kb-empty { color: var(--muted); font-style: italic; }
.kb-more { margin: 10px 0 0; border-top: 1px solid var(--border); padding-top: 4px; }
.kb-more > summary { cursor: pointer; min-height: 44px; padding: 12px 0; display: list-item;
  list-style-position: inside; color: var(--accent); font-size: 0.85rem; }
.kb-fields { margin: 4px 0 0; }
.kb-field { margin: 0 0 10px; }
.kb-field dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.05em; }
.kb-field dd { margin: 3px 0 0; font-size: 0.9rem; overflow-wrap: break-word; }
.kb-chip { display: inline-block; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 2px 8px; margin: 0 6px 6px 0; font-size: 0.85rem; }
.kb-callid { margin: 10px 0 0; color: var(--muted); font-size: 0.8rem; }
.kb-filters-mobile { display: none; }
.kb-filters-mobile > summary { cursor: pointer; min-height: 44px; padding: 12px 14px;
  display: list-item; list-style-position: inside; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--radius); font-weight: 600;
  font-size: 0.9rem; }
.kb-filters-mobile[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.kb-pager-bottom { display: none; }
/* ---- Below 900px the nine-column table cannot give its four free-text columns a readable
   measure (the five pinned columns alone total 628px), so the card list takes over. ---- */
@media (max-width: 899px) {
  /* 640px, not just 100%: without a cap this stylesheet is a PHONE layout applied to any viewport
     under 900px, including a portrait tablet — an 880px screen would otherwise stack six full-bleed,
     ~856px-wide filter controls and stretch a card's timestamp/urgency pair to opposite edges of an
     ~856px row. main already centers with margin: 0 auto, so capping it here gives a tablet a
     conventional, centred phone-width column instead. (No env(safe-area-inset-*): the viewport meta
     never sets viewport-fit=cover, so those resolve to 0 and a max() around them was dead code.) */
  main { max-width: 640px; padding: 12px 12px 24px; }
  .kb-cards { display: block; }
  .table-wrap { display: none; }
  h1 { font-size: 1.25rem; }
  .kb-filters-desktop { display: none; }
  .kb-filters-mobile { display: block; }
  /* Everything below is scoped under .kb-filters-mobile because both rules assume the form is the
     one embedded in the mobile disclosure, not any other use of form.filters: border-top: 0 plus
     the two zeroed top radii assume an attached summary bar directly above (pairing with the [open]
     rule that squares off the summary's own bottom corners, so the bar and form read as one
     continuous panel), and hiding .filters-label assumes the summary bar already said "Filters"
     immediately above it. */
  .kb-filters-mobile form.filters { flex-direction: column; align-items: stretch; border-top: 0;
    border-top-left-radius: 0; border-top-right-radius: 0; }
  .kb-filters-mobile form.filters label { width: 100%; }
  .kb-filters-mobile form.filters input, .kb-filters-mobile form.filters select,
  .kb-filters-mobile form.filters button { width: 100%; min-width: 0;
    min-height: 44px; font-size: 16px; }
  .kb-filters-mobile .filters-label { display: none; }
  .kb-pager-bottom { display: flex; }
  .pager { flex-wrap: wrap; gap: 8px; }
  .pager a, .exports a { min-height: 44px; display: inline-flex; align-items: center;
    padding: 0 16px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); text-decoration: none; }
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
  const cards = `<div class="kb-cards">${dto.results.map(cardHtml).join('')}</div>`;

  const prevHref = dto.page > 1 ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page - 1}`) : '';
  const nextHref =
    dto.page < dto.total_pages ? esc(`/knowledge${qs ? `${qs}&` : '?'}page=${dto.page + 1}`) : '';
  const pager =
    `<div class="pager">` +
    (prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : '<span></span>') +
    `<span>Page ${esc(String(dto.page))} of ${esc(String(dto.total_pages))} · ${esc(String(dto.total))} total</span>` +
    (nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : '<span></span>') +
    `</div>`;
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager kb-pager-bottom">');

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Knowledge base</title><style>${STYLE}</style></head><body>` +
    siteHeader('Knowledge base') +
    `<main>` +
    `<h1>Knowledge base</h1>` +
    pageIntro(
      'The finished record of every customer call: what they were calling about, the type of ' +
        'work, how urgent it was, the symptoms they described, and a few phrases in their own ' +
        'words. Filter by date, intent, category or urgency, and export what you find as CSV ' +
        'or JSON. Names, phone numbers and addresses were removed before any of this was ' +
        'written down.',
    ) +
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
