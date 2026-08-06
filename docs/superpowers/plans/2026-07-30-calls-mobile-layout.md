# All-calls mobile layout + shared card system Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/calls` the same mobile card layout `/knowledge` got in PR #107, by extracting the card system into one shared module both pages use rather than copying it a second time.

**Architecture:** A new `src/ui/cards.ts` exports `CARD_STYLE` (card chrome + the whole `@media (max-width: 899px)` switch) and `cardField()` (the labelled `<dt>/<dd>` block with its empty-value rule). `src/knowledge/render.ts` migrates onto it, renaming its `kb-*` classes to neutral ones. `src/status/calls-render.ts` then gets a flat card per call for the cost of importing the module and writing one `cardHtml`.

**Tech Stack:** TypeScript (strict), Vitest, server-rendered HTML strings, inline CSS over the existing `THEME` custom properties.

**Spec:** `docs/superpowers/specs/2026-07-30-calls-mobile-layout-design.md`

---

## Background the implementer needs

Both pages are server-rendered, script-free HTML under a strict CSP. **No JavaScript may be added.**

`src/ui/chrome.ts` exports `THEME` (design tokens + `.mono`, `.muted`, `.table-scroll`, `.site-header`), `esc()`, `fmtTs()`, `siteHeader()`, `logoutScript()`. **`chrome.ts` is not modified by this plan.**

`src/status/calls-render.ts` renders `/calls`. Its DTO (`src/status/calls.ts`):

```ts
export interface CallListItem {
  call_id: string;
  status: string;
  current_stage: string;
  created_at: string;
  updated_at: string;
  outcome: CallOutcome;      // { key, label, reason: string | null }
}
export interface CallsPage {
  items: CallListItem[]; page: number; page_size: number;
  total: number; total_pages: number; filter: string;
}
```

It already has local `esc()`, `humanizeStage()`, `badge()` (an inline-coloured `.badge` span from `BADGE_COLOR`), `rowHtml()`, `COLGROUP`, `STYLE`, and `renderCallsPage()`.

**Run a single test file:** `npx vitest run test/status/calls-render.test.ts`

**Run the DB-backed suites** (several skip silently without these):

```sh
TEST_DATABASE_URL="postgres://ovieoghor@localhost:5432/gcp_call_insights_test" \
TEST_RAW_DATABASE_URL="postgres://ovieoghor@localhost:5432/gcp_raw_test" \
npx vitest run test/knowledge test/status
```

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/ui/cards.ts` | Create | `CARD_STYLE` + `cardField()`. The one home for the card system and the responsive switch. |
| `src/knowledge/render.ts` | Modify | Import `CARD_STYLE`/`cardField`; delete the moved CSS and `detailBlock`; rename `kb-*` → neutral. Keeps only KB-specific rules. |
| `test/knowledge/render.test.ts` | Modify | Class strings updated for the rename. **No structural changes.** |
| `src/status/calls-render.ts` | Modify | Import `CARD_STYLE`/`cardField`; add `cardHtml`, the card list, and the bottom pager. |
| `test/status/calls-render.test.ts` | Create | Unit tests over `renderCallsPage`. No DB, no HTTP. |

---

## The rename map (all 15 — nothing left to judgement)

| current | becomes | moves to `cards.ts`? |
| --- | --- | --- |
| `kb-cards` | `cards` | yes |
| `kb-card` | `card` | yes |
| `kb-card-head` | `card-head` | yes |
| `kb-meta` | `card-meta` | yes |
| `kb-fields` | `fields` | yes |
| `kb-field` | `field` | yes |
| `kb-chip` | `chip` | yes |
| `kb-callid` | `callid` | yes |
| `kb-pager-bottom` | `pager-bottom` | yes |
| `kb-urgency` | `kb-urgency` | no — KB-specific |
| `kb-more` | `kb-more` | no — KB-specific |
| `kb-problem` | `kb-problem` | no — KB-specific |
| `kb-empty` | `kb-empty` | no — KB-specific |
| `kb-filters-mobile` | `kb-filters-mobile` | no — KB-specific |
| `kb-filters-desktop` | `kb-filters-desktop` | no — KB-specific |

---

## Task 1: Extract `src/ui/cards.ts` and migrate the knowledge page

This is the risky task: it edits a page currently running in production. The 21 existing tests in `test/knowledge/render.test.ts` are the safety net — they assert on these exact class strings and on the CSS rules themselves.

**Files:**

- Create: `src/ui/cards.ts`
- Modify: `src/knowledge/render.ts`
- Modify: `test/knowledge/render.test.ts`

- [ ] **Step 1: Capture the desktop baseline BEFORE touching anything**

This is the evidence for "desktop rendering unchanged". Build at the current commit and save the rendered page:

```sh
npm run build
mkdir -p /tmp/kbproof
node -e "
const {renderKnowledgePage}=require('./dist/knowledge/render.js');
const r={call_id:'c1',created_at:'2026-07-27T19:32:04.000Z',call_intent:'new_booking',
service_category:'water_heater',urgency:'emergency',problem_statement:'No hot water',
symptoms:['a','b'],customer_language:['c'],concerns:['d'],competitor_mentions:['e'],
acquisition_source:'f',location_in_home:'g',access_or_scheduling_notes:'h',prior_attempts:'i'};
const v={filters:{q:'x'},page:1,page_size:50,total:1,total_pages:2,results:[r],
summary:{total:1,date_span:{from:null,to:null},by_service_category:[],by_call_intent:[],
by_urgency:[],narrative:'n'}};
require('fs').writeFileSync('/tmp/kbproof/before.html', renderKnowledgePage(v));
"
wc -c /tmp/kbproof/before.html
```

Expected: a byte count printed. Keep this file — Step 8 diffs against it.

- [ ] **Step 2: Create `src/ui/cards.ts`**

```ts
import { esc } from './chrome.js';

/**
 * The shared mobile card system, used by every surface whose desktop view is a wide table that
 * cannot survive a phone viewport (`/knowledge`, `/calls`). It owns the card chrome AND the whole
 * responsive switch, so a surface opts in by appending {@link CARD_STYLE} to its own `<style>`,
 * emitting a `.cards` list beside its table, and giving its bottom pager the `pager-bottom` class.
 *
 * Deliberately NOT part of `chrome.ts`'s `THEME`: that block's contract is that it never redefines
 * selectors individual pages already style, and `.pill` / `.sla-*` are already owned by
 * `src/review/render.ts`. A separate module pages explicitly import sidesteps that contract rather
 * than testing it.
 *
 * No JavaScript: every consumer is script-free under a strict CSP, so disclosure is native
 * `<details>` and the layout switch is a media query, never a resize listener.
 */

/** One labelled block in a card. Returns '' for a null scalar, a blank or whitespace-only string,
 *  an empty array, or an array with no non-blank elements, so an absent (or effectively-absent)
 *  field never costs a blank row or an empty chip. Arrays render as `.chip` spans. */
export function cardField(label: string, value: string | readonly string[] | null): string {
  if (value === null) return '';
  if (Array.isArray(value)) {
    // Re-typed explicitly: `Array.isArray` narrowing a `readonly string[] | string` union leaves
    // TS unable to resolve element types on further chaining — an annotation, not a cast.
    const arr: readonly string[] = value;
    const populated = arr.filter((v) => v.trim().length > 0);
    if (populated.length === 0) return '';
    const chips = populated.map((v) => `<span class="chip">${esc(v)}</span>`).join('');
    return `<div class="field"><dt>${esc(label)}</dt><dd>${chips}</dd></div>`;
  }
  const text = String(value);
  if (text.trim().length === 0) return '';
  return `<div class="field"><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`;
}

/**
 * Card chrome plus the responsive switch. Append AFTER a page's own base rules and BEFORE any
 * page-specific media query, so a page can still override inside its own `@media` block.
 */
export const CARD_STYLE = `
.cards { display: none; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; margin: 0 0 12px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.card-head time { color: var(--muted); font-size: 0.78rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.card-meta { margin: 8px 0 0; font-weight: 600; font-size: 0.95rem; }
.fields { margin: 4px 0 0; }
.field { margin: 0 0 10px; }
.field dt { color: var(--muted); font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.05em; }
.field dd { margin: 3px 0 0; font-size: 0.9rem; overflow-wrap: break-word; }
.chip { display: inline-block; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 2px 8px; margin: 0 6px 6px 0; font-size: 0.85rem; }
.callid { margin: 10px 0 0; color: var(--muted); font-size: 0.8rem; }
.pager-bottom { display: none; }
/* ---- Below 900px a wide fixed-layout table cannot give its free-text columns a readable measure
   (the pinned columns alone exceed a phone viewport), so the card list takes over. ---- */
@media (max-width: 899px) {
  /* 640px, not just 100%: without a cap this is a PHONE layout applied to any viewport under
     900px, including a portrait tablet — an 880px screen would otherwise stack full-bleed ~856px
     controls and stretch a card's timestamp/badge pair to opposite edges. main already centers
     with margin: 0 auto, so capping it gives a tablet a centred phone-width column instead.
     (No env(safe-area-inset-*): no consumer sets viewport-fit=cover, so those resolve to 0.) */
  main { max-width: 640px; padding: 12px 12px 24px; }
  .cards { display: block; }
  .table-wrap { display: none; }
  h1 { font-size: 1.25rem; }
  form.filters { flex-direction: column; align-items: stretch; }
  form.filters label { width: 100%; }
  form.filters input, form.filters select, form.filters button { width: 100%; min-width: 0;
    min-height: 44px; font-size: 16px; }
  .pager-bottom { display: flex; }
  .pager { flex-wrap: wrap; gap: 8px; }
  /* .exports exists only on /knowledge; the selector is inert elsewhere, which is cheaper than
     duplicating these five declarations into that page and letting the two drift. */
  .pager a, .exports a { min-height: 44px; display: inline-flex; align-items: center;
    padding: 0 16px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); text-decoration: none; }
}
`;
```

**The 16px on form controls is load-bearing, not cosmetic:** mobile Safari force-zooms the viewport whenever a focused control is under 16px, and both pages' controls inherit a 15px body font.

- [ ] **Step 3: Migrate `src/knowledge/render.ts` — imports and `detailBlock`**

Add to the imports:

```ts
import { CARD_STYLE, cardField } from '../ui/cards.js';
```

**Delete** the entire `detailBlock` function (it has moved to `cards.ts` as `cardField`). In `cardHtml`, replace every `detailBlock(` call with `cardField(`. There are eight.

- [ ] **Step 4: Apply the rename inside `src/knowledge/render.ts`**

Using the rename map above, rename the nine `kb-*` names marked "yes". Touch **only** class-name strings — no markup structure, no logic. The five KB-specific names are unchanged.

Note `kb-meta` → `card-meta` specifically (not `meta`), and that `.kb-problem.kb-empty` keeps both KB names.

- [ ] **Step 5: Delete the moved CSS from `STYLE` and splice in `CARD_STYLE`**

In the `STYLE` template literal, **delete** these rules (they now live in `cards.ts`): `.kb-cards`, `.kb-card`, `.kb-card-head`, `.kb-card-head time`, `.kb-meta`, `.kb-fields`, `.kb-field`, `.kb-field dt`, `.kb-field dd`, `.kb-chip`, `.kb-callid`, `.kb-pager-bottom`.

From inside the existing `@media (max-width: 899px)` block, **delete**: the `main` rule, `.kb-cards`, `.table-wrap`, `h1`, `.pager-bottom`, `.pager`, and the `.pager a, .exports a` rule, plus the generic form rules that are now shared.

**Keep** in the knowledge page (these are genuinely KB-specific):

- Base: `.kb-urgency` + its four modifiers, `.kb-problem`, `.kb-problem.kb-empty`, `.kb-more`, `.kb-more > summary`, `.kb-filters-mobile`, `.kb-filters-mobile > summary`, `.kb-filters-mobile[open] > summary`.
- Inside its own `@media (max-width: 899px)` block: `.kb-filters-desktop { display: none; }`, `.kb-filters-mobile { display: block; }`, the `.kb-filters-mobile form.filters` border-joining rules, `.kb-filters-mobile .filters-label { display: none; }`, and `.exports { display: flex; ... }`.

Then change the `STYLE` declaration so `CARD_STYLE` sits between the page's base rules and the page's own media query:

```ts
const STYLE = THEME + `
...the page's own base rules, unchanged...
` + CARD_STYLE + `
...the KB-specific base rules and the KB @media block...
`;
```

**Two `@media (max-width: 899px)` blocks with the same query is valid CSS and intended.** The page's own block comes second, so its rules win where they overlap.

- [ ] **Step 6: Update the class strings in `test/knowledge/render.test.ts`**

Apply the same rename to the 30 class references. **Only the strings change.** If any assertion needs a *structural* change to pass, STOP and report — that means the rename altered behaviour, which it must not.

- [ ] **Step 7: Run the tests**

```sh
npx vitest run test/knowledge/render.test.ts
```

Expected: 21 passing. Then `npm run lint`, `npm run typecheck`, `npm run format:check`.

- [ ] **Step 8: Prove the desktop rendering is unchanged**

Rebuild, re-render the identical fixture, and diff against the Step 1 baseline **after applying the rename map to the old output**:

```sh
npm run build
node -e "
const {renderKnowledgePage}=require('./dist/knowledge/render.js');
const r={call_id:'c1',created_at:'2026-07-27T19:32:04.000Z',call_intent:'new_booking',
service_category:'water_heater',urgency:'emergency',problem_statement:'No hot water',
symptoms:['a','b'],customer_language:['c'],concerns:['d'],competitor_mentions:['e'],
acquisition_source:'f',location_in_home:'g',access_or_scheduling_notes:'h',prior_attempts:'i'};
const v={filters:{q:'x'},page:1,page_size:50,total:1,total_pages:2,results:[r],
summary:{total:1,date_span:{from:null,to:null},by_service_category:[],by_call_intent:[],
by_urgency:[],narrative:'n'}};
require('fs').writeFileSync('/tmp/kbproof/after.html', renderKnowledgePage(v));
"
sed -e 's/kb-cards/cards/g; s/kb-card-head/card-head/g; s/kb-card/card/g; s/kb-meta/card-meta/g' \
    -e 's/kb-fields/fields/g; s/kb-field/field/g; s/kb-chip/chip/g; s/kb-callid/callid/g' \
    -e 's/kb-pager-bottom/pager-bottom/g' \
    /tmp/kbproof/before.html > /tmp/kbproof/before-renamed.html
diff <(grep -o '<body>.*' /tmp/kbproof/before-renamed.html) \
     <(grep -o '<body>.*' /tmp/kbproof/after.html) && echo "BODY IDENTICAL"
```

**`sed` order matters** — `kb-card-head` must be substituted before `kb-card`, and `kb-fields` before `kb-field`, or the shorter pattern eats the longer one. The commands above are already ordered correctly.

Expected: `BODY IDENTICAL`. The `<style>` block legitimately differs (rules moved), so the diff is scoped to the body markup.

**If the body differs, STOP and report the diff.** A body difference means the rename changed the markup, which it must not.

- [ ] **Step 9: Commit**

```sh
git add src/ui/cards.ts src/knowledge/render.ts test/knowledge/render.test.ts
git commit -F - <<'MSG'
refactor(ui): extract the mobile card system into src/ui/cards.ts

The /calls page needs the same card layout /knowledge got in PR #107, and
the two stylesheets were already 80% byte-identical copies before either
had a mobile view — 24 of the 30 rule lines. Copying the card CSS across
would have taken that to ~90% and created a second place to change any
shared decision.

CARD_STYLE and cardField now live in one module both pages import. Not in
chrome.ts's THEME: that block's contract is that it never redefines what
pages already style, and .pill / .sla-* are already owned by the review
surface.

The knowledge page's kb- classes are renamed to neutral ones since they
are no longer knowledge-specific. Desktop body markup verified identical
modulo the rename.
MSG
```

---

## Task 2: The all-calls card

**Files:**

- Create: `test/status/calls-render.test.ts`
- Modify: `src/status/calls-render.ts`

- [ ] **Step 1: Capture the calls desktop baseline first**

```sh
npm run build
mkdir -p /tmp/callsproof
node -e "
const {renderCallsPage}=require('./dist/status/calls-render.js');
const i={call_id:'c1',status:'held',current_stage:'fetch-transcript',
created_at:'2026-07-28T14:32:00.000Z',updated_at:'2026-07-28T14:35:00.000Z',
outcome:{key:'held',label:'Held',reason:'Missing transcript'}};
require('fs').writeFileSync('/tmp/callsproof/before.html',
  renderCallsPage({items:[i],page:1,page_size:50,total:1,total_pages:2,filter:'all'}));
"
```

- [ ] **Step 2: Write the failing tests**

Create `test/status/calls-render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderCallsPage } from '../../src/status/calls-render.js';
import type { CallListItem, CallsPage } from '../../src/status/calls.js';

/**
 * Pure unit tests over the all-calls renderer (mobile card layout). No database and no HTTP.
 *
 * Assertions are scoped to the CARD REGION via `cardsOf`. The desktop table emits the same
 * strings, so a whole-page assertion passes even when the card is deleted — a class of vacuity
 * found repeatedly while building the knowledge-base equivalent (PR #107).
 *
 * The `mobileRules`/`base` assertions are LITERAL STRING MATCHES against rendered CSS text, not a
 * parsed stylesheet: reordering a selector list or reflowing whitespace fails them even though the
 * CSS is equivalent. Deliberate tradeoff — read a failure before assuming the styling regressed.
 */

function item(overrides: Partial<CallListItem> = {}): CallListItem {
  return {
    call_id: '6159886818426880',
    status: 'held',
    current_stage: 'fetch-transcript',
    created_at: '2026-07-28T14:32:00.000Z',
    updated_at: '2026-07-28T14:35:00.000Z',
    outcome: { key: 'held', label: 'Held', reason: 'Missing transcript' },
    ...overrides,
  };
}

function page(overrides: Partial<CallsPage> = {}): CallsPage {
  return {
    items: [item()],
    page: 1,
    page_size: 50,
    total: 1,
    total_pages: 1,
    filter: 'all',
    ...overrides,
  };
}

/** The `<div class="cards">…</div>` region only. Depth-counted: cards contain nested divs, and
 *  markup follows the list, so a slice to the first `</div>` would lie. */
function cardsOf(html: string): string {
  const open = '<div class="cards">';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('no cards region in the rendered page');
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) depth += 1;
    else if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
    }
  }
  throw new Error('unbalanced cards region');
}

/** The BODY of the mobile media query only. A slice to end-of-document would let a rule anywhere
 *  later in the stylesheet satisfy a mobile-only assertion. */
function mobileRules(html: string): string {
  const open = '@media (max-width: 899px) {';
  const start = html.indexOf(open);
  if (start === -1) throw new Error('no mobile media query in the rendered page');
  let depth = 0;
  for (let i = start + open.length - 1; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    else if (html[i] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced media query');
}

describe('all-calls mobile cards', () => {
  it('renders every field of a call on the card', () => {
    const region = cardsOf(renderCallsPage(page()));
    expect(region).toContain('6159886818426880');
    // fmtTs renders the FULL date: `2026-07-28 14:32`, not a short `07-28`.
    expect(region).toContain('2026-07-28 14:32');
    expect(region).toContain('Held');
    expect(region).toContain('Missing transcript');
    expect(region).toContain('Fetch transcript');
  });

  it('shows Updated only when it actually differs from Created', () => {
    const differs = cardsOf(renderCallsPage(page()));
    expect(differs).toContain('<dt>Updated</dt>');
    expect(differs).toContain('2026-07-28 14:35');

    const same = cardsOf(
      renderCallsPage(page({ items: [item({ updated_at: '2026-07-28T14:32:00.000Z' })] })),
    );
    expect(same).not.toContain('<dt>Updated</dt>');
  });

  it('omits the reason line when there is no reason', () => {
    const region = cardsOf(
      renderCallsPage(
        page({ items: [item({ outcome: { key: 'customer_completed', label: 'Customer', reason: null } })] }),
      ),
    );
    expect(region).toContain('Customer');
    expect(region).not.toContain('class="card-meta"');
  });

  it('renders one card per call, in row order', () => {
    const region = cardsOf(
      renderCallsPage(
        page({ items: [item({ call_id: 'call_first' }), item({ call_id: 'call_second' })], total: 2 }),
      ),
    );
    expect(region.split('<article class="card"').length - 1).toBe(2);
    expect(region.indexOf('call_first')).toBeLessThan(region.indexOf('call_second'));
  });

  it('tells the reader nothing matched, rather than showing a blank screen', () => {
    const region = cardsOf(renderCallsPage(page({ items: [], total: 0, total_pages: 0 })));
    expect(region).not.toContain('<article');
    expect(region).toContain('No calls match this filter yet.');
  });

  it('escapes HTML-significant characters in every card-rendered field', () => {
    const hostile = '<script>alert("x")</script>';
    const html = renderCallsPage(
      page({
        items: [
          item({
            call_id: hostile,
            current_stage: hostile,
            outcome: { key: 'held', label: hostile, reason: hostile },
          }),
        ],
      }),
    );
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('all-calls layout switch', () => {
  it('ships both layouts in one response', () => {
    const html = renderCallsPage(page());
    expect(html).toContain('class="cards"');
    expect(html).toContain('class="table-wrap table-scroll"');
  });

  it('hides the table and shows the cards below the breakpoint', () => {
    const html = renderCallsPage(page());
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.cards { display: none; }');
    expect(mobileRules(html)).toContain('.cards { display: block; }');
    expect(mobileRules(html)).toContain('.table-wrap { display: none; }');
  });

  it('raises mobile form controls to 16px so Safari stops force-zooming on focus', () => {
    expect(mobileRules(renderCallsPage(page()))).toContain('font-size: 16px');
  });

  it('repeats the pager below the results, mobile-only', () => {
    const html = renderCallsPage(page({ page: 2, total_pages: 4, total: 168 }));
    expect(html).toContain('class="pager pager-bottom"');
    expect(html.split('Page 2 of 4').length - 1).toBe(2);
    const base = html.slice(0, html.indexOf('@media (max-width: 899px)'));
    expect(base).toContain('.pager-bottom { display: none; }');
    expect(mobileRules(html)).toContain('.pager-bottom { display: flex; }');
  });

  it('gives the pager a 44px minimum tap target on mobile', () => {
    expect(mobileRules(renderCallsPage(page()))).toContain('min-height: 44px');
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

```sh
npx vitest run test/status/calls-render.test.ts
```

Expected: FAIL — there is no card region yet, so `cardsOf` throws.

- [ ] **Step 4: Add the card renderer**

In `src/status/calls-render.ts`, add the import:

```ts
import { CARD_STYLE, cardField } from '../ui/cards.js';
```

and insert after the existing `rowHtml`:

```ts
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
```

- [ ] **Step 5: Splice `CARD_STYLE` into the page's `STYLE`**

Change the `STYLE` declaration so `CARD_STYLE` follows the page's own base rules:

```ts
const STYLE = THEME + `
...existing rules, unchanged...
` + CARD_STYLE;
```

The calls page needs **no** page-specific media query: everything it wants — hiding the table, showing the cards, the 640px cap, the stacked 16px form, the 44px pager, the bottom pager — comes from `CARD_STYLE`. That is the extraction paying off.

- [ ] **Step 6: Emit the card list and the bottom pager**

In `renderCallsPage`, after the `table` assignment, add:

```ts
  const cards =
    `<div class="cards">` +
    (dto.items.length > 0
      ? dto.items.map(cardHtml).join('')
      : `<p class="muted">No calls match this filter yet.</p>`) +
    `</div>`;
```

After the `pager` assignment, add:

```ts
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager pager-bottom">');
```

Then in the return expression, change `table +` to:

```ts
    table +
    cards +
    pagerBottom +
```

**Confirm by reading the code that `pager` really begins with the literal `<div class="pager">`** — if it does not, the replace silently no-ops and the bottom pager duplicates the top one.

- [ ] **Step 7: Prove the new assertions discriminate — REQUIRED, report each**

Four rounds on the knowledge-base branch shipped tests that passed with the implementation deleted. Apply each mutation, run the suite, record whether it FAILED, then revert:

1. Remove `cards +` from the return expression.
2. Delete the `Updated` conditional so it always renders.
3. Change the base `.cards { display: none; }` in `cards.ts` to `display: block;`.
4. Delete `.table-wrap { display: none; }` from `CARD_STYLE`'s media query.
5. Remove the empty-state fallback so an empty list renders nothing.

**If any mutation does NOT cause a failure, stop and report it before committing.**

Note that mutations 3 and 4 touch `cards.ts`, so they should also fail the knowledge-base suite — run both.

- [ ] **Step 8: Verify and prove desktop unchanged**

```sh
npx vitest run test/status/calls-render.test.ts
npm run lint && npm run typecheck && npm run format:check && npm run build
```

Then the desktop proof — for this page the new elements are additions, so scope the diff to the table and form regions:

```sh
node -e "
const {renderCallsPage}=require('./dist/status/calls-render.js');
const i={call_id:'c1',status:'held',current_stage:'fetch-transcript',
created_at:'2026-07-28T14:32:00.000Z',updated_at:'2026-07-28T14:35:00.000Z',
outcome:{key:'held',label:'Held',reason:'Missing transcript'}};
require('fs').writeFileSync('/tmp/callsproof/after.html',
  renderCallsPage({items:[i],page:1,page_size:50,total:1,total_pages:2,filter:'all'}));
"
for f in before after; do
  grep -o '<form class="filters".*</form>' /tmp/callsproof/$f.html > /tmp/callsproof/$f.form
  grep -o '<div class="table-wrap.*</table></div>' /tmp/callsproof/$f.html > /tmp/callsproof/$f.table
done
diff /tmp/callsproof/before.form /tmp/callsproof/after.form && echo "FORM IDENTICAL"
diff /tmp/callsproof/before.table /tmp/callsproof/after.table && echo "TABLE IDENTICAL"
```

Expected: both `IDENTICAL`. If not, STOP and report the diff.

- [ ] **Step 9: Commit**

```sh
git add src/status/calls-render.ts test/status/calls-render.test.ts
git commit -F - <<'MSG'
feat(status): mobile card layout for the all-calls page

/calls carried the same defect PR #107 fixed on /knowledge: five pinned
columns totalling 662px left the Reason column zero width at ~390px, so
its text broke one character per line.

The card is flat rather than an expander — with six short fields a
disclosure control would hide almost nothing while costing a tap, so
copying the knowledge page's shape here would be copying its form
without its reasoning. Updated shows only when it differs from Created.

The page needs no media query of its own: hiding the table, the 640px
tablet cap, the stacked 16px form and the 44px pager all arrive with
CARD_STYLE. Desktop table and form markup verified byte-identical.
MSG
```

---

## Task 3: Final gates and the pull request

- [ ] **Step 1: Full suite, with the databases connected**

```sh
TEST_DATABASE_URL="postgres://ovieoghor@localhost:5432/gcp_call_insights_test" \
TEST_RAW_DATABASE_URL="postgres://ovieoghor@localhost:5432/gcp_raw_test" \
npm run test
```

Expected: everything passes **except** 8 `test/db/` files (`eligibility-stamping`, `migration-017`, `migration-drop-reason`, `migration-extract-stage`, `migration-review-queue-active-unique`, `retention-purge-grants`, `roles-pre-provisioned`, `schema-roundtrip`). Those fail identically on unmodified `origin/main` — a known local-only `key_admin_role` environment issue, not this branch.

**If any OTHER file fails, stop.** If one of those 8 fails differently, verify against `origin/main` before assuming it is pre-existing.

- [ ] **Step 2: Remaining gates**

```sh
npm run lint && npm run typecheck && npm run build && npm run format:check
npm audit --audit-level=high
```

- [ ] **Step 3: Eyeball both pages**

Render each from synthetic data and open at ~390px, ~880px and ~1400px. Confirm: cards on the phone, a centred column on the tablet (not full-bleed controls), and both desktop tables exactly as before.

- [ ] **Step 4: Open the PR**

Write the body to a scratch file, then create the PR. Do not use a heredoc nested inside a
double-quoted `-m` argument — that has thrown a bash parse error twice on this project.

```sh
cat > /tmp/callspr.md <<'BODY'
## What

`/calls` carried the same defect PR #107 fixed on `/knowledge`, from the same cause: `table-layout: fixed` plus a `<colgroup>` pinning five of six columns to **662px** total left the `Reason` column `max(0, 358 - 662) = 0` on a ~390px phone, and `word-break: break-word` then broke its text one character per line.

Below 900px the page now renders a flat card per call. The desktop table is unchanged.

## Why a shared module, not a second copy

The two stylesheets were **already 80% byte-identical before either had a mobile view** — 24 of the 30 rule lines in `calls-render.ts`'s `STYLE` matched `render.ts` exactly. Copying the card CSS across would have taken that to ~90% and created a second place to change any shared decision.

`src/ui/cards.ts` now owns `CARD_STYLE` (card chrome + the entire responsive switch) and `cardField()`. `/calls` needs **no media query of its own** — hiding the table, the 640px tablet cap, the stacked 16px form and the 44px pager all arrive with the import.

Deliberately **not** in `chrome.ts`'s `THEME`: that block's contract is that it never redefines selectors individual pages already style, and `.pill` / `.sla-*` are already owned by `src/review/render.ts:44-49`. A module pages explicitly import sidesteps the contract rather than testing it.

This also partly resolves PR #107's deferred `STYLE`-split follow-up: the card CSS leaves `render.ts` as a side effect of the extraction, rather than as a risky standalone shuffle.

## Scope — siblings checked, not assumed

- `src/status/render.ts` (`/status`) uses `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` and flex rows. No table. **Not affected.**
- `src/review/render.ts` is already a `.item` card list. **Not affected.**
- `src/console/home-render.ts` is a tile grid. **Not affected.**

`/calls` was the last surface with the crushing bug.

## Design note

The card is **flat, not an expander**. With six short fields a disclosure control would hide almost nothing while costing a tap — applying PR #107's shape here would be copying its form without its reasoning. `Updated` renders only when it differs from `Created`, so its presence carries information instead of restating the line above.

## Desktop unchanged — proved, not asserted

- **`/knowledge`:** rendered before and after, applied the rename map to the old output, diffed the `<body>` — identical.
- **`/calls`:** rendered before and after, diffed the `<form>` and `<table>` regions — identical.

The `kb-*` → neutral rename is mechanical; the 21 tests from PR #107 assert on those exact class strings and on the CSS rules themselves, so a missed rename fails loudly.

## Verification

Every new assertion was mutation-tested: the card list, the `Updated` conditional, both display toggles and the empty state were each deleted in turn and confirmed to fail the suite. Presentation only — no route, query, DTO or data change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY

git push -u origin task/7.3b-calls-mobile-layout
gh pr create --base main \
  --title "feat(status): mobile card layout for all-calls, via a shared card system" \
  --body-file /tmp/callspr.md
```

---

## Self-review notes

**Spec coverage.** Shared module → Task 1 Step 2. Rename (all 15) → Task 1 Steps 4/6. Flat card → Task 2 Step 4. `Updated` only when differing → Task 2 Step 4, asserted both directions in Step 2. Empty state → Task 2 Steps 2/6. Escaping test → Task 2 Step 2. Desktop-unchanged proofs → Task 1 Step 8 and Task 2 Step 8. Collision check → already run and recorded in the spec; no plan step needed. Testing section → Task 2 Steps 2/7.

**Known risk.** Task 1 edits a page running in production. Mitigated by the 21 existing tests plus the Step 8 body-identical proof, and by the rule that any assertion needing a *structural* change is a stop-and-report signal rather than an edit.

**`sed` ordering.** The rename script substitutes longer patterns before their prefixes (`kb-card-head` before `kb-card`, `kb-fields` before `kb-field`). Getting this backwards silently corrupts the proof rather than failing it.
