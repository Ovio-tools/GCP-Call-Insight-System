# Knowledge-base mobile layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the knowledge-base page readable on a phone by rendering a tap-to-expand card list below 900 px, while leaving the desktop table byte-for-byte unchanged.

**Architecture:** One server-rendered response carries both layouts; a single `@media (max-width: 899px)` block selects one. No JavaScript is added — the page is script-free under a strict CSP, so progressive disclosure uses native `<details>`. All new code and CSS live in `src/knowledge/render.ts` under `kb-`-prefixed class names; `src/ui/chrome.ts` is not touched.

**Tech Stack:** TypeScript (strict), Vitest, server-rendered HTML strings, inline CSS using the existing `THEME` custom properties.

**Spec:** `docs/superpowers/specs/2026-07-27-knowledge-base-mobile-layout-design.md`

---

## Background the implementer needs

`src/knowledge/render.ts` builds the whole page as one HTML string. It already has:

- `esc(value)` — escapes `& < > " '`. **Every interpolated value must pass through it.**
- `fmtCreatedCt(iso)` — formats the timestamp as `MM-DD-YYYY HH:MM:SS CT`.
- `humanizeLabel(key)` (imported from `./summary.js`) — `water_heater` → `Water heater`.
- `rowHtml(r)` / `COLGROUP` / `STYLE` — the existing desktop table. **Do not modify these.**
- `renderKnowledgePage(dto, chrome)` — the single export.

The record type is `KnowledgeRecord` in `src/knowledge/dto.ts`, with 14 fields. The
existing table renders 9; this plan surfaces the other 5 on the card.

Enum values you will need:

- `URGENCY = ['emergency', 'urgent', 'routine']`
- `CALL_INTENT = ['new_booking', 'existing_job', 'quote', 'emergency', 'billing', 'general']`
- `SERVICE_CATEGORIES` includes `'water_heater'`, `'toilet'`, …

Theme tokens already defined in `src/ui/chrome.ts` and available to the page:
`--bg --panel --panel-2 --panel-3 --border --border-2 --text --muted --accent`
`--ok-bg --ok-fg --warn-bg --warn-fg --bad-bg --bad-fg --radius`.

**Run a single test file with:** `npx vitest run test/knowledge/render.test.ts`

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/knowledge/render.ts` | Modify | Add card renderers, urgency pill, active-filter count, mobile CSS. Existing table code untouched. |
| `test/knowledge/render.test.ts` | Create | Pure unit tests over `renderKnowledgePage` — no database, no HTTP. |

No other file changes. Routes, queries, DTOs, CSV/JSON serializers and the egress
guard are all out of scope.

---

## Task 1: Card renderer — urgency pill and detail blocks

**Files:**

- Create: `test/knowledge/render.test.ts`
- Modify: `src/knowledge/render.ts` (add after `rowHtml`, around line 98)

- [ ] **Step 1: Write the failing test**

Create `test/knowledge/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderKnowledgePage } from '../../src/knowledge/render.js';
import type { KnowledgeRecord, KnowledgeView } from '../../src/knowledge/dto.js';

/**
 * Pure unit tests over the knowledge page renderer (mobile card layout). No database and no HTTP:
 * `renderKnowledgePage` takes a already-sanitized DTO and returns a string, so the whole mobile
 * layout is testable from a literal. The escaping cases matter most — the card is a NEW
 * interpolation site and does not inherit the table's proof of safety.
 */

/** A fully-populated record: every one of the 14 DTO fields carries a distinct, greppable value. */
function record(overrides: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
  return {
    call_id: 'call_abc123',
    created_at: '2026-07-27T19:32:04.000Z',
    call_intent: 'new_booking',
    service_category: 'water_heater',
    urgency: 'emergency',
    problem_statement: 'No hot water since last night',
    symptoms: ['no hot water', 'pilot will not stay lit'],
    customer_language: ['it just keeps clicking'],
    concerns: ['cost', 'how soon'],
    competitor_mentions: ['Acme Plumbing'],
    acquisition_source: 'Google search',
    location_in_home: 'Basement utility room',
    access_or_scheduling_notes: 'Dog in the yard',
    prior_attempts: 'Relit it twice',
    ...overrides,
  };
}

function view(overrides: Partial<KnowledgeView> = {}): KnowledgeView {
  return {
    filters: {},
    page: 1,
    page_size: 50,
    total: 1,
    total_pages: 1,
    results: [record()],
    summary: {
      total: 1,
      date_span: { from: null, to: null },
      by_service_category: [],
      by_call_intent: [],
      by_urgency: [],
      narrative: '1 record matches the current filters.',
    },
    ...overrides,
  };
}

describe('mobile card layout', () => {
  it('renders every one of the 14 record fields, including the five the table never showed', () => {
    const html = renderKnowledgePage(view());

    // The nine the table already showed.
    expect(html).toContain('call_abc123');
    expect(html).toContain('07-27-2026');
    expect(html).toContain('New booking');
    expect(html).toContain('Water heater');
    expect(html).toContain('Emergency');
    expect(html).toContain('No hot water since last night');
    expect(html).toContain('pilot will not stay lit');
    expect(html).toContain('it just keeps clicking');
    expect(html).toContain('how soon');

    // The five that previously reached only the CSV and JSON exports.
    expect(html).toContain('Basement utility room');
    expect(html).toContain('Dog in the yard');
    expect(html).toContain('Relit it twice');
    expect(html).toContain('Acme Plumbing');
    expect(html).toContain('Google search');
  });

  it('maps each urgency onto its own pill class, with a neutral fallback', () => {
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'emergency' })] }))).toContain(
      'kb-urgency u-emergency',
    );
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'urgent' })] }))).toContain(
      'kb-urgency u-urgent',
    );
    expect(renderKnowledgePage(view({ results: [record({ urgency: 'routine' })] }))).toContain(
      'kb-urgency u-routine',
    );
  });

  it('omits the expander entirely when every expandable field is empty, but keeps the call id', () => {
    const bare = record({
      symptoms: [],
      customer_language: [],
      concerns: [],
      competitor_mentions: [],
      acquisition_source: null,
      location_in_home: null,
      access_or_scheduling_notes: null,
      prior_attempts: null,
    });
    const html = renderKnowledgePage(view({ results: [bare] }));

    expect(html).not.toContain('kb-more');
    expect(html).not.toContain('More details');
    expect(html).toContain('call_abc123');
    // The problem statement is NOT expandable, so it still shows on the collapsed card.
    expect(html).toContain('No hot water since last night');
  });

  it('escapes HTML-significant characters in every card-rendered free-text field', () => {
    const hostile = '<script>alert("x")</script>';
    const html = renderKnowledgePage(
      view({
        results: [
          record({
            call_id: hostile,
            problem_statement: hostile,
            symptoms: [hostile],
            customer_language: [hostile],
            concerns: [hostile],
            competitor_mentions: [hostile],
            acquisition_source: hostile,
            location_in_home: hostile,
            access_or_scheduling_notes: hostile,
            prior_attempts: hostile,
          }),
        ],
      }),
    );

    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    // Ten fields carried the payload; each must appear escaped, not swallowed.
    expect(html.split('&lt;script&gt;').length - 1).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge/render.test.ts`

Expected: FAIL. The first test fails on `expect(html).toContain('Basement utility room')` because
no card exists yet and the table has no column for it.

- [ ] **Step 3: Add the card renderers**

In `src/knowledge/render.ts`, insert immediately after `rowHtml` (after line 98, before the
`COLGROUP` declaration):

```ts
/** Urgency → theme-token pill class. Total over `URGENCY`, with a neutral fallback so an enum
 *  value added later renders as a plain pill rather than an unstyled one. */
const URGENCY_PILL: Record<string, string> = {
  emergency: 'u-emergency',
  urgent: 'u-urgent',
  routine: 'u-routine',
};

function urgencyPill(urgency: string): string {
  const cls = URGENCY_PILL[urgency] ?? 'u-other';
  return `<span class="kb-urgency ${cls}">${esc(humanizeLabel(urgency))}</span>`;
}

/** One labelled block inside a card's expander. Returns '' for a null scalar, an empty string, or
 *  an empty array, so an absent field costs no blank row. */
function detailBlock(label: string, value: string | readonly string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    const chips = value.map((v) => `<span class="kb-chip">${esc(String(v))}</span>`).join('');
    return `<div class="kb-field"><dt>${esc(label)}</dt><dd>${chips}</dd></div>`;
  }
  const text = String(value);
  if (text.length === 0) return '';
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

  const callIdField = `<div class="kb-field"><dt>Call</dt><dd class="mono">${esc(r.call_id)}</dd></div>`;
  const more = blocks
    ? `<details class="kb-more"><summary>More details</summary>` +
      `<dl class="kb-fields">${blocks}${callIdField}</dl></details>`
    : `<p class="kb-callid mono">${esc(r.call_id)}</p>`;

  const problem = r.problem_statement
    ? `<p class="kb-problem">${esc(r.problem_statement)}</p>`
    : `<p class="kb-problem kb-empty">No problem statement recorded.</p>`;

  return (
    `<article class="kb-card">` +
    `<div class="kb-card-head"><time>${esc(fmtCreatedCt(r.created_at))}</time>` +
    `${urgencyPill(r.urgency)}</div>` +
    `<p class="kb-meta">${esc(humanizeLabel(r.service_category))} &middot; ` +
    `${esc(humanizeLabel(r.call_intent))}</p>` +
    problem +
    more +
    `</article>`
  );
}
```

- [ ] **Step 4: Wire the card list into the page**

Still in `src/knowledge/render.ts`, inside `renderKnowledgePage`, find this line (currently ~line 180):

```ts
  const table = `<div class="table-wrap table-scroll"><table>${COLGROUP}<thead>${header}</thead><tbody>${body}</tbody></table></div>`;
```

Add directly beneath it:

```ts
  const cards = `<div class="kb-cards">${dto.results.map(cardHtml).join('')}</div>`;
```

Then find the return expression's `table +` line (currently ~line 203) and change it to:

```ts
    table +
    cards +
```

- [ ] **Step 5: Add the card CSS**

In `src/knowledge/render.ts`, append to the `STYLE` template literal, immediately before its
closing backtick (after the `.foot` rule, currently ~line 141):

```css
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
.kb-more > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center;
  color: var(--accent); font-size: 0.85rem; }
.kb-fields { margin: 4px 0 0; }
.kb-field { margin: 0 0 10px; }
.kb-field dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.05em; }
.kb-field dd { margin: 3px 0 0; font-size: 0.9rem; overflow-wrap: break-word; }
.kb-chip { display: inline-block; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 2px 8px; margin: 0 6px 6px 0; font-size: 0.85rem; }
.kb-callid { margin: 10px 0 0; color: var(--muted); font-size: 0.8rem; }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/knowledge/render.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/render.ts test/knowledge/render.test.ts
git commit -m "feat(knowledge): render each record as a mobile card

Adds a tap-to-expand card per record alongside the existing table. The
expander surfaces the five fields the desktop table has no column for
(location_in_home, access_or_scheduling_notes, prior_attempts,
competitor_mentions, acquisition_source), which the HTML route already
receives scanned and scrubbed by serializeKnowledgeView.

The card is a new interpolation site, so it gets its own escaping test
rather than inheriting the table's."
```

---

## Task 2: Layout switch — cards below 900px, table above

**Files:**

- Modify: `src/knowledge/render.ts` (the `STYLE` literal)
- Test: `test/knowledge/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge/render.test.ts`:

```ts
describe('layout switch', () => {
  it('ships both layouts in one response, since the choice is made client-side', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('class="kb-cards"');
    expect(html).toContain('class="table-wrap table-scroll"');
  });

  it('hides the table and shows the cards below the 900px breakpoint', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('@media (max-width: 899px)');
    // Inside the breakpoint the roles invert: cards become visible, the table goes away.
    const mq = html.slice(html.indexOf('@media (max-width: 899px)'));
    expect(mq).toContain('.kb-cards { display: block; }');
    expect(mq).toContain('.table-wrap { display: none; }');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge/render.test.ts -t 'layout switch'`

Expected: FAIL on `expect(html).toContain('@media (max-width: 899px)')` — the file has no media
query. (`grep -rn "@media" src/` currently returns nothing at all.)

- [ ] **Step 3: Add the media query**

Append to the `STYLE` literal in `src/knowledge/render.ts`, after the card rules from Task 1:

```css
/* ---- Below 900px the nine-column table cannot give its four free-text columns a readable
   measure (the five pinned columns alone total 628px), so the card list takes over. ---- */
@media (max-width: 899px) {
  main { padding: 12px max(12px, env(safe-area-inset-right)) 24px max(12px, env(safe-area-inset-left)); }
  .kb-cards { display: block; }
  .table-wrap { display: none; }
  h1 { font-size: 1.25rem; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/knowledge/render.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/render.ts test/knowledge/render.test.ts
git commit -m "feat(knowledge): switch to the card list below 900px

One response carries both layouts and a single media query picks one, so
rotating or resizing re-flows without a server round trip and without
user-agent sniffing. The desktop table is emitted unchanged.

This is the first @media rule in the repository."
```

---

## Task 3: Collapsible filters with an active count

Six filter controls stack to roughly a full phone screen before any result is visible. On
mobile they collapse behind a summary bar; on desktop the form renders exactly as it does today.

**Why the form is emitted twice:** `open` is an HTML attribute and CSS cannot set it, so a single
`<details>` cannot be collapsed-by-default on mobile *and* always-open on desktop. The
`::details-content` pseudo-element that would allow it is too new to depend on, and this page is
deliberately script-free. Emitting the small form twice is the honest trade.

**Files:**

- Modify: `src/knowledge/render.ts`
- Test: `test/knowledge/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge/render.test.ts`:

```ts
describe('collapsible filters', () => {
  it('labels the bar plainly when nothing is filtered, and stays closed', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('<summary>Filters</summary>');
    expect(html).not.toContain('<details class="kb-filters-mobile" open>');
  });

  it('counts the active filters and opens the bar so a filtered view never hides why', () => {
    const html = renderKnowledgePage(
      view({ filters: { q: 'heater', urgency: 'emergency' } }),
    );
    expect(html).toContain('Filters &middot; 2 active');
    expect(html).toContain('<details class="kb-filters-mobile" open>');
  });

  it('counts every filter kind, not just the free-text one', () => {
    const html = renderKnowledgePage(
      view({
        filters: {
          q: 'heater',
          service_category: 'water_heater',
          call_intent: 'new_booking',
          urgency: 'emergency',
          from: '2026-07-01',
          to: '2026-07-31',
        },
      }),
    );
    expect(html).toContain('Filters &middot; 6 active');
  });

  it('renders the form for both layouts', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('class="kb-filters-desktop"');
    expect(html).toContain('class="kb-filters-mobile"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge/render.test.ts -t 'collapsible filters'`

Expected: FAIL on `expect(html).toContain('<summary>Filters</summary>')` — the form is currently
rendered bare, with no wrapper.

- [ ] **Step 3: Add the active-filter count**

In `src/knowledge/render.ts`, add after the `filterQuery` function (currently ~line 59):

```ts
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
```

- [ ] **Step 4: Wrap the form for both layouts**

In `renderKnowledgePage`, find the line assigning `form` (currently ~line 150) and leave it
alone. Directly after the closing `` `</form>`; `` line, add:

```ts
  const activeCount = activeFilterCount(f);
  const filtersSummary =
    activeCount === 0 ? 'Filters' : `Filters &middot; ${esc(String(activeCount))} active`;
  const filtersBlock =
    `<div class="kb-filters-desktop">${form}</div>` +
    `<details class="kb-filters-mobile"${activeCount > 0 ? ' open' : ''}>` +
    `<summary>${filtersSummary}</summary>${form}</details>`;
```

Then in the return expression, replace:

```ts
    form +
```

with:

```ts
    filtersBlock +
```

- [ ] **Step 5: Add the filter CSS**

Append to the `STYLE` literal, **before** the `@media` block added in Task 2:

```css
.kb-filters-mobile { display: none; }
.kb-filters-mobile > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center;
  padding: 0 14px; background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); font-weight: 600; font-size: 0.9rem; }
.kb-filters-mobile[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
```

Then add these rules **inside** the existing `@media (max-width: 899px)` block:

```css
  .kb-filters-desktop { display: none; }
  .kb-filters-mobile { display: block; }
  form.filters { flex-direction: column; align-items: stretch; border-top: 0;
    border-top-left-radius: 0; border-top-right-radius: 0; }
  form.filters label { width: 100%; }
  form.filters input, form.filters select, form.filters button { width: 100%; min-width: 0;
    min-height: 44px; font-size: 16px; }
```

The `font-size: 16px` is load-bearing, not cosmetic: mobile Safari force-zooms the viewport
whenever a focused form control is under 16px, and these inherit the 15px body font today.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/knowledge/render.test.ts`

Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add src/knowledge/render.ts test/knowledge/render.test.ts
git commit -m "feat(knowledge): collapse the filters behind a summary bar on mobile

Six stacked controls filled the first phone screen before a single result
appeared. The bar shows an active count and opens itself when a filter is
set, so a filtered view never hides why it is filtered.

Also raises mobile form controls to 16px: Safari force-zooms the viewport
for any focused control below that, and they inherited the 15px body font."
```

---

## Task 4: Tap targets and the bottom pager

`← Prev`, `Next →`, `CSV` and `JSON` are bare inline links roughly 20px tall, against a
44 × 44px minimum. The pager also sits only above a full page of results.

**Files:**

- Modify: `src/knowledge/render.ts`
- Test: `test/knowledge/render.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/knowledge/render.test.ts`:

```ts
describe('mobile tap targets', () => {
  it('repeats the pager below the results, mobile-only so desktop is unchanged', () => {
    const html = renderKnowledgePage(view({ page: 2, total_pages: 4, total: 168 }));
    expect(html).toContain('class="pager kb-pager-bottom"');
    // Above and below: the page indicator appears twice.
    expect(html.split('Page 2 of 4').length - 1).toBe(2);
  });

  it('gives the pager and export links a 44px minimum tap target on mobile', () => {
    const html = renderKnowledgePage(view());
    const mq = html.slice(html.indexOf('@media (max-width: 899px)'));
    expect(mq).toContain('.pager a, .exports a');
    expect(mq).toContain('min-height: 44px');
  });

  it('hides the duplicated bottom pager at desktop widths', () => {
    const html = renderKnowledgePage(view());
    expect(html).toContain('.kb-pager-bottom { display: none; }');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/knowledge/render.test.ts -t 'mobile tap targets'`

Expected: FAIL on `expect(html).toContain('class="pager kb-pager-bottom"')` — there is one pager
and it has no second class.

- [ ] **Step 3: Emit the bottom pager**

In `renderKnowledgePage`, find the `pager` assignment (currently ~line 185). Leave it, and add
directly after it:

```ts
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager kb-pager-bottom">');
```

Then in the return expression, after `cards +`, add:

```ts
    pagerBottom +
```

- [ ] **Step 4: Add the tap-target CSS**

Add these rules **inside** the existing `@media (max-width: 899px)` block:

```css
  .kb-pager-bottom { display: flex; }
  .pager { flex-wrap: wrap; gap: 8px; }
  .pager a, .exports a { min-height: 44px; display: inline-flex; align-items: center;
    padding: 0 16px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); text-decoration: none; }
  .exports { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
```

And add this rule **outside** the media query (with the other base rules, so desktop keeps its
single pager):

```css
.kb-pager-bottom { display: none; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/knowledge/render.test.ts`

Expected: PASS, 13 tests.

- [ ] **Step 6: Commit**

```bash
git add src/knowledge/render.ts test/knowledge/render.test.ts
git commit -m "feat(knowledge): give the pager and export links real tap targets

Prev/Next/CSV/JSON were ~20px inline links against a 44px minimum. On
mobile they become button-styled controls and the pager repeats below the
card list, so paging does not mean scrolling back to the top. The extra
pager is mobile-only; desktop keeps its single one."
```

---

## Task 5: Prove nothing else regressed, and close out

The change is presentation-only, so the existing suites are the real safety net —
especially `pii-egress` and `no-restricted-data`, which now run against a page containing
five additional fields.

- [ ] **Step 1: Run the full knowledge and security suites**

```bash
npx vitest run test/knowledge test/security
```

Expected: PASS. **If `pii-egress` or `no-restricted-data` fails, stop.** That is a signal to
re-examine the change, not to relax the test — those two suites are the privacy boundary.

- [ ] **Step 2: Run every pre-PR gate**

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run format:check
```

Expected: all five pass. Run `npm run format` first if `format:check` complains.

- [ ] **Step 3: Check the rendered page by eye at both widths**

```bash
npx vitest run test/knowledge/render.test.ts
```

Then, to look at real output rather than assertions, start the console surface and open
`/knowledge` in a browser at 390px wide (device toolbar) and at 1400px. Confirm:

- 390px: cards, no sideways pan, tapping a filter does not zoom the page, "More details" expands.
- 1400px: the table looks exactly as it did before this branch.

Compare against `git stash` / `git stash pop` on the desktop view if in any doubt.

- [ ] **Step 4: Audit dependencies**

```bash
npm audit --audit-level=high
```

Expected: no high or critical advisories introduced by this branch (it adds no dependencies).

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin task/10.1b-kb-mobile-layout
gh pr create --base main --title "feat(knowledge): mobile card layout for the knowledge base" --body "$(cat <<'EOF'
## What

The knowledge base was unreadable on a phone: the five pinned table columns total 628px, so on a ~390px screen the four free-text columns got zero remaining width and broke at every character.

Below 900px the page now renders a tap-to-expand card per record. The desktop table is emitted unchanged.

## Also fixed

- Mobile form controls raised to 16px, so Safari stops force-zooming on focus.
- The inner `max-height` scroll region is gone on mobile — the card list scrolls with the page.
- Prev/Next/CSV/JSON get 44px tap targets; the pager repeats below the list.
- Urgency renders as a colour-coded pill using theme tokens that already existed.
- Five fields that reached only the CSV/JSON exports (`location_in_home`, `access_or_scheduling_notes`, `prior_attempts`, `competitor_mentions`, `acquisition_source`) now appear on the card.

## Privacy

No new egress path. `/knowledge` already builds its DTO through `serializeKnowledgeView`, and `sanitizeKnowledgeRecord` already names all five fields — the HTML route receives them scanned and scrubbed today and merely declines to print them. The residual risk is XSS-by-omission in new render code, so the card gets its own escaping test rather than inheriting the table's.

Presentation only: no data, query, DTO, export or egress-guard change. No JavaScript added.

Spec: `docs/superpowers/specs/2026-07-27-knowledge-base-mobile-layout-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

**Spec coverage.** All nine defects map to a task: crushed columns → Tasks 1–2; iOS zoom →
Task 3 Step 5; nested scroll trap → Task 2 Step 3 (`.table-wrap { display: none }` removes the
`max-height` region on mobile); tap targets → Task 4; filters consuming the screen → Task 3;
character-level word breaking → Task 1 Step 5 (`overflow-wrap: break-word` on card prose, and the
`th, td` rule no longer applies once the table is hidden); horizontal pan → Task 2 (the overflowing
table is gone); urgency weight → Task 1; five invisible fields → Task 1. Testing section → Tasks 1,
3 and 5. Risks section → Task 5 Step 1.

**Deviation from the spec, already folded back into it.** The spec originally placed the pill and
tap-target rules in `src/ui/chrome.ts`'s shared `THEME`. `.pill` and the `.sla-*` classes are
already defined in `src/review/render.ts:44-49`, and `THEME`'s docblock says it deliberately does
not redefine what pages already style. Everything is therefore knowledge-scoped under `kb-`, and
`src/ui/chrome.ts` is untouched.

**Known cost.** The response carries both layouts, roughly doubling HTML for the view at
`KNOWLEDGE_PAGE_SIZE_DEFAULT` records per page. Exports are unaffected.
