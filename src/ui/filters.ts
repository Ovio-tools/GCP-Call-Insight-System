/**
 * Shared auto-apply behaviour for the `form.filters` bar on `/knowledge`, `/notes`, and `/calls`.
 * Picking a drop-down applies the filter immediately, so the Search button stops being a step you
 * have to remember — on a phone, where the bar is a collapsed panel, it was a tap and a hunt.
 *
 * Deliberate boundaries:
 *
 * - **Drop-downs only.** A text `change` fires on blur, so auto-applying the free-text and date
 *   boxes would navigate the moment you clicked away toward a drop-down and swallow that click.
 *   Those boxes keep their native behaviour (Enter, or the button), and whatever is typed in them
 *   is always carried along when a drop-down fires.
 * - **The button stays.** It applies typed values, and it is the whole experience when scripts are
 *   blocked — nothing here is required for the page to work.
 * - **The panel marker is a URL hash.** `/knowledge` and `/notes` validate their query with a
 *   `.strict()` zod schema, so an extra query parameter would be a 400; `#filters` is never sent to
 *   the server. It re-opens the mobile `<details>` after the reload so a second filter does not cost
 *   another tap.
 * - **No ids, no classes on the wrapper.** `/knowledge` and `/notes` render the SAME form twice (a
 *   desktop copy and a mobile one inside `<details>`, under different wrapper class names), so this
 *   works per-form and finds the panel with `closest('details')`.
 *
 * Strict CSP (`src/http/plugins/security.ts`): inline + nonce'd, `addEventListener` only, no `on*=`
 * attribute, no external script. Same shape as {@link logoutScript}.
 */

import { esc, type Chrome } from './chrome.js';

/** The hash that means "the mobile Filters panel was open when this navigation started". */
const OPEN_MARKER = '#filters';

/**
 * The nonce'd inline script that makes every filter bar on the page apply on selection. Render it
 * once per page, alongside {@link logoutScript}. A page without a nonce gets an inert script, which
 * is exactly what the read-only unit renders want.
 */
export function filtersScript(chrome: Chrome): string {
  return (
    `<script nonce="${esc(chrome.nonce ?? '')}">` +
    `(function(){` +
    `var busy=false;` +
    `var forms=document.querySelectorAll('form.filters');` +
    `var reopen=window.location.hash===${JSON.stringify(OPEN_MARKER)};` +
    // Read values off the live controls rather than a FormData snapshot: the typed boxes must
    // contribute whatever they hold at the moment the drop-down fires.
    `function target(form,panel){` +
    `var fields=form.querySelectorAll('select,input');var parts=[];` +
    `for(var i=0;i<fields.length;i++){var el=fields[i];` +
    `var t=(el.type||'').toLowerCase();` +
    `if(t==='submit'||t==='reset'||t==='button')continue;` +
    `if(!el.name||!el.value)continue;` +
    `parts.push(encodeURIComponent(el.name)+'='+encodeURIComponent(el.value));}` +
    // `page` is not a control, so it drops out here — a filter change resets to page 1, which is
    // exactly what clicking Search does today.
    `return form.getAttribute('action')+(parts.length?'?'+parts.join('&'):'')+` +
    `((panel&&panel.open)?${JSON.stringify(OPEN_MARKER)}:'');}` +
    `function wire(form){` +
    `var panel=form.closest('details');` +
    `if(panel&&reopen){panel.open=true;}` +
    `var fields=form.querySelectorAll('select,input');` +
    `for(var i=0;i<fields.length;i++){` +
    `if(fields[i].tagName!=='SELECT')continue;` +
    `fields[i].addEventListener('change',function(){` +
    // One navigation per selection: a change landing while the browser is already leaving would
    // otherwise fire a second load with the same values.
    `if(busy)return;busy=true;window.location.assign(target(form,panel));});}}` +
    `for(var i=0;i<forms.length;i++){wire(forms[i]);}` +
    `})();` +
    `</script>`
  );
}
