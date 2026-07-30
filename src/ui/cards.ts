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
/* Both classes, deliberately: the bottom pager carries class="pager pager-bottom", and a page's
   own .pager { display: flex } is also (0,1,0) — so a single-class rule here would tie on
   specificity and let SOURCE ORDER decide whether the duplicate pager shows on desktop. That would
   make this block's placement load-bearing in a way nothing tests: splice it right after THEME (the
   natural instinct) and the bottom pager silently appears at every width. At (0,2,0) it wins
   wherever it sits. */
.pager.pager-bottom { display: none; }
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
  .pager.pager-bottom { display: flex; }
  .pager { flex-wrap: wrap; gap: 8px; }
  /* .exports exists only on /knowledge; the selector is inert elsewhere, which is cheaper than
     duplicating these five declarations into that page and letting the two drift. */
  .pager a, .exports a { min-height: 44px; display: inline-flex; align-items: center;
    padding: 0 16px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); text-decoration: none; }
}
`;
