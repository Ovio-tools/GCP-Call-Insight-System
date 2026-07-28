# Knowledge-base mobile layout — design

**Date:** 2026-07-27
**Status:** Approved design, pending implementation plan
**Area:** knowledge-base surface presentation (`src/knowledge/render.ts`, `src/ui/chrome.ts`)

## Problem

The knowledge-base page is unreadable on a phone. A screenshot at ~390 px viewport
width shows the free-text columns collapsed to a single character wide, rendering
their content as a vertical stream of letters down the right edge of the screen.

The page is a server-rendered, script-free HTML table with **nine columns** and no
responsive rules of any kind. `grep -n "@media" src/` returns **zero hits** across the
whole repository — no surface has ever been given a breakpoint.

### Root cause (confirmed by reading the CSS, not theorized)

`src/knowledge/render.ts` sets `table { table-layout: fixed; width: 100% }` and pins
five columns to explicit widths via `COLGROUP`:

| col        | width  |
| ---------- | ------ |
| `c-id`     | 116 px |
| `c-time`   | 176 px |
| `c-intent` | 116 px |
| `c-cat`    | 128 px |
| `c-urg`    | 92 px  |
| **total**  | **628 px** |

Under CSS fixed table layout the specified widths are honoured first and the four
unsized free-text columns (`Problem`, `Symptoms`, `Customer language`, `Concerns`)
divide whatever remains. On a 390 px phone the content box is ~358 px, so the
remainder is `max(0, 358 - 628) = 0`. The four text columns get no width, and
`th, td { word-break: break-word; overflow-wrap: anywhere }` then breaks their content
at every character rather than letting it overflow. That is precisely the observed
one-letter-per-line rendering.

### The full defect list

The crushed columns are the visible symptom; the review found nine distinct problems.

1. **Crushed free-text columns** — root cause above.
2. **iOS focus zoom** — `form.filters input, form.filters select` inherit the 15 px
   body font (`font: inherit`). Mobile Safari force-zooms the viewport on focus for
   any form control below 16 px. One pixel under the threshold.
3. **Nested scroll trap** — `.table-wrap { max-height: calc(100vh - 260px) }` combined
   with `.table-scroll { overflow-x: auto }` (which computes `overflow-y` to `auto`)
   creates a ~600 px inner scroll region independent of row count. This is the large
   empty box in the screenshot, and on touch it steals scroll from the page.
4. **Sub-minimum tap targets** — `← Prev`, `Next →`, `CSV` and `JSON` are bare inline
   `<a>` elements roughly 20 px tall, against a 44 × 44 px minimum.
5. **Filters consume the first screen** — six controls at `min-width: 150px` in a
   `flex-wrap` row stack to about one full phone screen before any result is visible.
6. **Character-level word breaking** — `word-break: break-word` +
   `overflow-wrap: anywhere` should not apply to prose in a comfortable measure.
7. **Horizontal page pan** — the overflowing table makes the whole document
   pannable sideways.
8. **Urgency has no visual weight** — the field most worth scanning for renders as
   plain muted text, while the theme already defines unused
   `--bad-bg/--bad-fg`, `--warn-bg/--warn-fg`, `--ok-bg/--ok-fg` pill tokens.
9. **Five fields are invisible on the web page** — `knowledgeRecordSchema` carries 14
   fields; the HTML table renders 9. `location_in_home`,
   `access_or_scheduling_notes`, `prior_attempts`, `competitor_mentions` and
   `acquisition_source` reach the CSV and JSON exports but were never given columns.

## Approach

Three approaches were considered.

**A. Dual markup, CSS-selected (chosen).** The response carries both a card list and
the existing table; one media query displays exactly one of them. Desktop markup is
untouched. Costs roughly a doubling of row bytes (~50 records per page at
`KNOWLEDGE_PAGE_SIZE_DEFAULT`, so on the order of 50 KB extra per page).

**B. Restyle the same table into cards** via `data-label` attributes and
`display: block` at the breakpoint. No byte cost, single copy of the data. Rejected:
a table row cannot host a `<details>` progressive-disclosure block cleanly, and the
five missing fields could not be surfaced without also adding five desktop columns.
It satisfies neither accepted requirement.

**C. Server-side device detection.** Rejected: user-agent sniffing is unreliable,
interacts badly with caching, and would not re-flow on rotation or window resize.

A is chosen because it is the only option that delivers tap-to-expand cards and the
five hidden fields, and because it cannot regress the desktop view — the desktop
markup is emitted unchanged.

### Non-goals

Presentation only. No change to the data model, queries, DTOs, exports, the
`/knowledge.json` view body, the PII egress guards, pagination semantics, or any
surface other than the knowledge base. No JavaScript is introduced: the page is
script-free today and the strict CSP is a reason to keep it that way.

## Design

### Breakpoint

A single `@media (max-width: 899px)` rule. At 900 px and above the existing table is
shown and the card list is hidden; below it, the reverse. 900 px is chosen because the
nine columns need ~900 px before the free-text columns become narrower than a readable
measure. Phones and portrait tablets therefore get cards.

Both layouts render from the same `KnowledgeRecord[]`; neither is authoritative over
the other, and no server-side branch decides which one the client uses.

### Card anatomy

One `<article class="kb-card">` per record, in the same order as the table rows.

Collapsed (always visible):

- Header line: created timestamp (`MM-DD-YYYY HH:MM:SS CT`, the existing
  `fmtCreatedCt`) and an urgency pill, colour-mapped from the existing theme tokens.
- Sub-line: service category `·` call intent, humanized via the existing
  `humanizeLabel`.
- Body: `problem_statement` as ordinary prose.

Expanded, behind a `<details><summary>More details</summary>` — plain HTML, no
script, so it works under the strict CSP:

- `symptoms`, `customer_language`, `concerns` as labelled lists.
- `location_in_home`, `access_or_scheduling_notes`, `prior_attempts`,
  `competitor_mentions`, `acquisition_source` as labelled values.
- `call_id`, monospaced, last.

**Empty-field rule:** a `null` field or an empty array is omitted from the card
entirely rather than rendered as a blank row. If every expandable field is empty, the
`<details>` block itself is omitted, so no card offers an expander that reveals
nothing.

Every value continues to pass through the existing `esc()` before interpolation. The
card adds no new data source: it renders fields already present in
`knowledgeRecordSchema`, which is itself the egress allowlist, and every record has
already cleared the value-level egress guard before reaching the renderer.

### Urgency pill mapping

`urgency` maps to the existing theme pairs:

| `urgency`   | tokens                  |
| ----------- | ----------------------- |
| `emergency` | `--bad-bg` / `--bad-fg`   |
| `urgent`    | `--warn-bg` / `--warn-fg` |
| `routine`   | `--ok-bg` / `--ok-fg`     |

The mapping is total over `URGENCY` (`['emergency', 'urgent', 'routine']`) with an
explicit neutral fallback, so an enum value added later renders as a plain pill rather
than an unstyled one.

### Filters

On mobile the filter form is wrapped in `<details class="kb-filters">` whose
`<summary>` reads `Filters` plus an active count derived server-side from the echoed
`dto.filters` (for example `Filters · 2 active`). The `<details>` is open by default
when at least one filter is active, so a filtered view never hides why it is filtered.
On desktop the form renders as it does today.

Inside, at mobile widths: fields go full width, one per line, and form controls are
set to `16px` to stop iOS focus zoom.

### Everything else at mobile widths

- `.table-wrap`'s `max-height` and the `.table-scroll` background/scroll treatment are
  dropped; the card list scrolls with the document. No nested scroll region.
- Sticky `<th>` is irrelevant once the table is hidden; no change needed beyond that.
- Pager links become `min-height: 44px` button-styled controls, and the pager is
  repeated below the card list as well as above it.
- Export links become button-styled controls at the same minimum size.
- `word-break: break-word` / `overflow-wrap: anywhere` do not apply to card prose;
  the `.mono` call-id keeps its ellipsis treatment.
- Horizontal padding uses `max(16px, env(safe-area-inset-*))` so notched and
  rounded-corner devices do not clip content.

### Where the code goes

- Card rendering, the urgency-pill mapping and the active-filter count live in
  `src/knowledge/render.ts` alongside the existing `rowHtml`.
- Genuinely generic pieces — the pill classes and the tap-target sizing — go in
  `src/ui/chrome.ts`'s `THEME` so the review and status surfaces can adopt them later
  without a second copy. `THEME` is additive by contract: it must not redefine
  selectors individual pages already style.
- No route, query, DTO, CSV or JSON module is touched.

## Testing

`test/knowledge/` currently asserts nothing about table markup (`grep` for `<td>`,
`<th>`, `colgroup`, `table-wrap` across `test/knowledge/` and `test/security/` returns
no hits), so the existing suite should stay green without modification. That is a
constraint to verify, not an assumption to rely on.

New coverage:

- **Field parity:** every field the card can render is asserted present in the HTML
  for a fully-populated record, including the five previously invisible ones.
- **Empty-field omission:** a record whose expandable fields are all null/empty
  renders no `<details>` block and no blank rows.
- **Escaping:** a record carrying `<`, `>`, `&`, `"`, `'` in each card-rendered field
  emits no unescaped markup — the card is a new interpolation site and needs its own
  proof, not inherited confidence from the table's.
- **Egress:** the existing `pii-egress` and `no-restricted-data` suites must still
  pass unchanged against a page that now contains five additional fields; if either
  needs updating, that is a signal to re-examine the change, not to relax the test.
- **Active-filter count:** correct for zero, one and several active filters.
- **Both layouts present:** a single response contains both the card list and the
  table, since the selection is client-side.

## Risks

- **Page weight** roughly doubles for the HTML view. Bounded by
  `KNOWLEDGE_PAGE_SIZE_MAX`; the exports are unaffected.
- **New interpolation site.** Five fields that previously reached only CSV and JSON
  now reach HTML. They are inside the DTO allowlist and already egress-guarded, but
  the escaping test above exists specifically because "already safe elsewhere" is not
  proof of safety in a new sink.
- **`THEME` additions** must remain additive; a token or class that collides with a
  selector the review or status page already styles would change those pages
  silently.
