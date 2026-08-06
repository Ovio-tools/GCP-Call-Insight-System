# All-calls mobile layout + shared card system — design

**Date:** 2026-07-30
**Status:** Approved design, pending implementation plan
**Area:** status surface (`src/status/calls-render.ts`), knowledge surface
(`src/knowledge/render.ts`), new shared module (`src/ui/cards.ts`)

## Problem

The **All calls** page (`/calls`, rendered by `src/status/calls-render.ts`) has the
same defect PR #107 fixed on the knowledge base, from the same cause.

`table { table-layout: fixed; width: 100% }` plus a `<colgroup>` pinning five of six
columns:

| col         | width  |
| ----------- | ------ |
| `c-id`      | 116 px |
| `c-time`    | 132 px |
| `c-outcome` | 132 px |
| `c-stage`   | 150 px |
| `c-time`    | 132 px |
| **total**   | **662 px** |

On a ~390 px phone the content box is ~358 px, so the single unsized column
(`Reason`) gets `max(0, 358 - 662) = 0`, and
`th, td { word-break: break-word; overflow-wrap: anywhere }` breaks its content at
every character.

The page also repeats the sibling defects: the `.table-wrap { max-height: calc(100vh
- 260px) }` nested scroll trap, `form.filters select` inheriting the 15 px body font
(mobile Safari force-zooms any focused control under 16 px), and ~20 px `Prev`/`Next`
tap targets against a 44 px minimum.

### The duplication this sits on

The two stylesheets were already near-copies **before** any of this work. Measured on
the pre-change files: of the 30 rule lines in `calls-render.ts`'s `STYLE`, **24 are
byte-identical** to lines in `render.ts`'s — 80%. Both files also declare their own
local `esc()`. Adding the mobile work by copy-paste would take that to roughly 90%
and create a second place to change any shared decision.

### Sibling surfaces — checked, not assumed

- `src/status/render.ts` (the `/status` page) uses
  `display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` and
  flex rows. No table, no fixed colgroup. **Not affected by this defect.**
- `src/review/render.ts` uses `.item` blocks — already a card list. **Not affected.**
- `src/console/home-render.ts` is a tile grid. **Not affected.**

`/calls` is the last surface carrying the crushing bug. Scope is `/calls` only; any
smaller mobile polish on `/status` or `/review` is a separate, lower-value change.

## Approach

**Extract a shared card system, rather than copy the CSS a second time.**

Rejected alternative: duplicate the ~40 lines of card and responsive CSS into
`calls-render.ts`. It is faster and cannot touch the live knowledge-base page, but it
doubles down on the existing 80% duplication and leaves two places to change any
shared decision — which is how the two files drift.

### Where the shared code lives

A **new module, `src/ui/cards.ts`** — deliberately NOT `src/ui/chrome.ts`'s `THEME`.
`THEME`'s docblock states it never redefines selectors individual pages already style,
and that contract already bit once: `.pill` and `.sla-*` are owned by
`src/review/render.ts:44-49`, which is why PR #107 kept its urgency pill
knowledge-scoped. A separate module both pages explicitly import sidesteps the
question rather than testing the contract.

`src/ui/cards.ts` exports:

- **`CARD_STYLE`** — the card chrome (`.cards`, `.card`, `.card-head`, `.card-head
  time`, `.card-meta`, `.field`, `.field dt`, `.field dd`, `.chip`, `.callid`) plus
  the entire responsive switch: `@media (max-width: 899px)` hiding `.table-wrap`,
  showing `.cards`, capping `main` at 640 px, stacking `form.filters`, 16 px form
  controls, 44 px `.pager a` / `.exports a` tap targets, and the `.pager-bottom`
  toggle.
- **`cardField(label, value)`** — the labelled `<dt>/<dd>` block, including the
  empty-value rule: a `null` scalar, an empty or whitespace-only string, an empty
  array, and an array whose every element is blank all render `''`. Arrays render as
  `.chip` spans. This is PR #107's `detailBlock`, moved and renamed.

Each page keeps only what is genuinely its own: the knowledge base keeps its urgency
pill and `<details>` expander and its collapsible filter bar; all-calls keeps its
outcome `.badge`.

### The rename

Moving the CSS means the `kb-` prefix is wrong in shared code. The 15 `kb-*` class
names become neutral equivalents (`kb-cards` → `cards`, `kb-card` → `card`, and so
on). Names that stay knowledge-specific keep a prefix (`kb-urgency`, `kb-more`,
`kb-filters-mobile`, `kb-problem`).

The full mapping — all 15 existing `kb-*` names, so nothing is left to judgement:

| current             | becomes            | moves to `cards.ts`? |
| ------------------- | ------------------ | -------------------- |
| `kb-cards`          | `cards`            | yes                  |
| `kb-card`           | `card`             | yes                  |
| `kb-card-head`      | `card-head`        | yes                  |
| `kb-meta`           | `card-meta`        | yes                  |
| `kb-fields`         | `fields`           | yes                  |
| `kb-field`          | `field`            | yes                  |
| `kb-chip`           | `chip`             | yes                  |
| `kb-callid`         | `callid`           | yes                  |
| `kb-pager-bottom`   | `pager-bottom`     | yes                  |
| `kb-urgency`        | `kb-urgency`       | no — KB-specific     |
| `kb-more`           | `kb-more`          | no — KB-specific     |
| `kb-problem`        | `kb-problem`       | no — KB-specific     |
| `kb-empty`          | `kb-empty`         | no — KB-specific     |
| `kb-filters-mobile` | `kb-filters-mobile`| no — KB-specific     |
| `kb-filters-desktop`| `kb-filters-desktop`| no — KB-specific    |

This is a mechanical rename across `src/knowledge/render.ts` and its 30 references in
`test/knowledge/render.test.ts`. The 21 tests from PR #107 are the safety net: they
assert on these exact class strings and on the CSS rules themselves, so a missed
rename fails loudly rather than silently.

### Naming collision check — run, then found wrong, then fixed

An initial check claimed no collisions. **That was wrong**, and the way it was wrong is
worth recording: the grep required a non-letter before the dot, so every
**element-qualified** selector slipped through it. `src/console/home-render.ts` already
owned both `.card` and `.cards` — as `a.card` and `ul.cards`, a nav-tile grid with
entirely different semantics.

There was no rendered defect: home does not import `CARD_STYLE`, and `ul.cards` (0,1,1)
outranks `.cards` (0,1,0) regardless. But that is luck, not design — it holds only
because the selectors happened to be element-qualified. Home's classes are therefore
renamed to `.tile` / `.tiles`, which is also the more accurate name for what they are.

Remaining shared names — `.card-head`, `.card-meta`, `.fields`, `.field`, `.chip` — are
structurally scoped (they only ever appear inside a `.card`) and collide with nothing.
`.badge` is defined in `src/status/calls-render.ts:93`, stays owned by that page, and
does not enter the shared module.

**Lesson for any future collision check on a CSS class:** grep for the bare name, not
for a name preceded by a delimiter. `.foo` can be reached as `div.foo`, `.bar .foo`, or
`.foo.baz`, and a delimiter-anchored pattern misses the first of those entirely.

### The one real ordering hazard, removed rather than documented

`CARD_STYLE`'s `.pager-bottom { display: none; }` and each consumer's
`.pager { display: flex; }` are both specificity (0,1,0), and the bottom pager carries
**both** classes — so source order alone decided which won, and splicing the shared
block in the "obvious" place (right after `THEME`) would have silently shown the bottom
pager on desktop with no test failing.

Fixed in the cascade rather than in a comment: the rules are written
`.pager.pager-bottom` (0,2,0), so placement no longer changes the outcome. This is
verified by temporarily splicing `CARD_STYLE` before the page's base rules and
confirming the suite still passes.

## Design

### The all-calls card

Flat — every field visible, no expander. With six short fields (an id, two
timestamps, an enum badge, a short reason, a stage name) an expander would hide
almost nothing while adding a tap; applying PR #107's disclosure pattern here would
be copying its shape rather than its reasoning.

Collapsed content, in order:

- Header line: created timestamp (via the existing `fmtTs`) and the outcome badge.
- The humanized `reason` as a prominent line, when non-null.
- `Stage` (via the existing `humanizeStage`).
- `Updated` — **only when `updated_at` differs from `created_at`**. For a finished
  call the two are typically minutes apart and the second conveys nothing; showing it
  only when it differs means its presence carries information.
- `Call` — the call id, monospaced, with a `title` so it is not truncated silently.

Empty fields are omitted entirely, the same rule as the knowledge base.

The existing `.badge` keeps its per-outcome inline colour from `BADGE_COLOR`. Unlike
the knowledge base's urgency pill, it is already colour-coded and already scans well;
it needs no redesign, only a place on the card.

### The empty state

`calls-render.ts` already renders `No calls match this filter yet.` as a table row.
The card list needs the equivalent, so an empty result on a phone is not a blank
screen.

### What does not change

The desktop table on either page. The target diff shape is: additions, plus a
mechanical rename, with **desktop rendering byte-identical on both surfaces**. That
property is verifiable by rendering each page before and after at desktop width and
diffing — a plan step.

No route, query, DTO or data change. `calls.ts` is de-identified by construction (it
SELECTs only state-machine columns and never `source_metadata`); this change does not
touch it, and adds no field to the page that was not already in the table.

## Testing

- **New `test/status/calls-render.test.ts`** mirroring the knowledge-base suite's
  structure: an `item()`/`page()` builder pair, a depth-counted `cardsOf()` region
  slice, and a brace-counted `mobileRules()` slice. Assertions must be scoped to the
  card region — PR #107 found repeatedly that whole-page assertions pass while the
  card is deleted, because the table emits the same strings.
- **Card content:** all six fields render; the reason line is omitted when null; the
  `Updated` line appears only when the timestamps differ, and is absent when they
  match. Both directions must be asserted, or the rule can pass vacuously.
- **Empty state:** an empty result renders the card-list empty message.
- **Escaping:** the card is a new interpolation site and gets its own test, rather
  than inheriting the table's.
- **Both layouts present**, and the rules that do the switching asserted — not merely
  the class names. PR #107 shipped tests that passed with those rules deleted.
- **Desktop-unchanged proof:** render both pages at their pre-change commit and at
  HEAD and assert the desktop HTML is byte-identical modulo the rename.
- The existing 21 knowledge-base tests must pass after the rename with only the class
  strings updated. Any assertion needing a *structural* change is a signal the rename
  changed behaviour and must be investigated, not edited away.

## Risks

- **This edits a page now running in production.** The knowledge-base rename is
  mechanical and covered by 21 tests, but it is a real change to working code. That is
  the cost of not keeping the same CSS in two files; the alternative was accepted as
  worse.
- **Generic shared class names** (`.card`, `.field`, `.chip`) could collide with an
  existing surface stylesheet. Mitigated by the explicit collision check above.
- **`CARD_STYLE` is now load-bearing for two surfaces**, so a change to it affects
  both. That is the point, but it means its own regression tests matter more than a
  single page's would.
