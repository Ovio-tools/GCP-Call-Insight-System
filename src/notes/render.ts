import {
  NOTE_CORRECTABLE_VALUES,
  NOTE_FEEDBACK_VERDICTS,
  SERVICE_CATEGORIES,
  URGENCY,
  type NoteFeedbackVerdict,
  type NoteFieldPath,
  type Urgency,
} from '../db/enums.js';
import { THEME, esc, jsonForScript, logoutScript, siteHeader, type Chrome } from '../ui/chrome.js';
import { filtersScript } from '../ui/filters.js';
import { CARD_STYLE, cardField } from '../ui/cards.js';
import { humanizeLabel } from '../knowledge/summary.js';
import { fmtCreatedCt } from '../knowledge/render.js';
import type { NoteDetail, NoteFilters, NoteList, NoteListItem, NoteTally } from './dto.js';

/**
 * Server-rendered, self-contained pages for the note-review surface (ADR 0009): a paginated list, a
 * detail page, and the transcript modal. Inline CSS, no external assets, one nonce'd inline script
 * per page and NO inline event handler attributes (strict CSP).
 *
 * Every interpolated value is HTML-escaped. The DTO is already the egress allowlist and each note
 * has passed the value-level guard in `sanitize.ts` before it reaches here.
 */

/* ==================================================================================================
 * Labels — no snake_case ever reaches the screen.
 * ============================================================================================== */

/**
 * The plain-language label for every addressable note field.
 *
 * `satisfies Record<NoteFieldPath, string>` is load-bearing: a field path added to
 * `src/db/enums.ts` without a label here is a COMPILE error, not a raw `supply_shut_off` leaking
 * onto a reviewer's screen. `humanizeLabel` is not enough on its own — it would render
 * "Supply shut off", which reads as a question about the supply rather than about the water.
 */
const FIELD_LABELS = {
  scope_signal: 'How much of the property is involved',
  'equipment.type': 'Equipment',
  'equipment.brand': 'Brand',
  'equipment.model': 'Model',
  'equipment.capacity': 'Capacity',
  'equipment.approximate_age': 'Roughly how old',
  'equipment.fuel_type': 'Gas or electric',
  'system_context.waste_system': 'Waste system',
  'system_context.water_source': 'Water source',
  'system_context.foundation_type': 'Foundation',
  'system_context.property_age': 'Age of the property',
  'water_status.actively_running': 'Water running right now',
  'water_status.supply_shut_off': 'Water shut off at the supply',
  'water_status.shutoff_location_known': 'Customer knows where the shutoff is',
  'water_status.active_damage': 'Damage happening now',
  'payer_authority.can_approve_work': 'Can approve the work',
  'payer_authority.home_warranty': 'Home warranty involved',
  'payer_authority.insurance_claim': 'Insurance claim involved',
  'payer_authority.third_party_payer': 'Someone else is paying',
  'prior_work.is_repeat_visit': 'We have been out before',
  'prior_work.is_warranty_claim': 'Warranty claim on our work',
  'prior_work.prior_work_by_others': 'Another company worked on it',
  'commitments_made.price_quoted': 'A price was quoted',
  'commitments_made.dispatch_fee_mentioned': 'The dispatch fee was mentioned',
  'commitments_made.arrival_window_given': 'An arrival window was given',
  'commitments_made.technician_named': 'A technician was named',
  'commitments_made.scope_described': 'The work was described',
  location_on_property: 'Where on the property',
  symptom_verbatim: 'What the customer described',
  prior_attempts_detail: 'What has already been tried',
  access_notes: 'Getting in',
  hazards: 'Hazards',
  urgency_context: 'Why it is urgent',
  occupancy: 'Who we spoke to',
  not_established: 'Not confirmed on this call',
  dispatch_summary: 'The dispatch summary',
} as const satisfies Record<NoteFieldPath, string>;

/** The reviewer-facing wording for each verdict. `satisfies` pins it to the DB vocabulary, so a
 * fifth verdict cannot ship without a label. */
const VERDICT_LABELS = {
  correct: 'Right',
  wrong: 'Wrong',
  missing: 'Missing',
  should_not_be_here: "Shouldn't be here",
} as const satisfies Record<NoteFeedbackVerdict, string>;

/** What a reviewer is actually asserting, as a tooltip — "missing" vs "shouldn't be here" is the
 * distinction that makes the corpus worth having, so it is spelled out rather than guessed at. */
const VERDICT_HINTS = {
  correct: 'The call supports this.',
  wrong: 'The call covered this, but the note got it wrong.',
  missing: 'The call covered this and the note left it out.',
  should_not_be_here: 'The call never mentioned this — the note made it up.',
} as const satisfies Record<NoteFeedbackVerdict, string>;

/** The three judgeable groups, in the order a technician would use them. `not_established` and
 * `dispatch_summary` are rendered separately (the gap list and the headline artifact). */
const FIELD_GROUPS: readonly { heading: string; paths: readonly NoteFieldPath[] }[] = [
  {
    heading: 'The equipment and the property',
    paths: [
      'scope_signal',
      'equipment.type',
      'equipment.brand',
      'equipment.model',
      'equipment.capacity',
      'equipment.approximate_age',
      'equipment.fuel_type',
      'system_context.waste_system',
      'system_context.water_source',
      'system_context.foundation_type',
      'system_context.property_age',
    ],
  },
  {
    heading: 'Getting in and getting it done',
    paths: [
      'location_on_property',
      'access_notes',
      'occupancy',
      'symptom_verbatim',
      'prior_attempts_detail',
      'hazards',
      'urgency_context',
      'water_status.actively_running',
      'water_status.supply_shut_off',
      'water_status.shutoff_location_known',
      'water_status.active_damage',
      'prior_work.is_repeat_visit',
      'prior_work.is_warranty_claim',
      'prior_work.prior_work_by_others',
    ],
  },
  {
    heading: 'What the office promised',
    paths: [
      'commitments_made.price_quoted',
      'commitments_made.dispatch_fee_mentioned',
      'commitments_made.arrival_window_given',
      'commitments_made.technician_named',
      'commitments_made.scope_described',
      'payer_authority.can_approve_work',
      'payer_authority.home_warranty',
      'payer_authority.insurance_claim',
      'payer_authority.third_party_payer',
    ],
  },
];

/** How an unset field reads. One constant because it appears on every screen and in the tests. */
const NOT_STATED = 'not stated on the call';

/* ==================================================================================================
 * Small helpers
 * ============================================================================================== */

/** Read a note field by its dotted `field_path`. One level deep — the same shape
 * `src/technician-notes/gates.ts:129-134` walks, over the same vocabulary. */
function valueAtPath(note: NoteDetail, path: NoteFieldPath): unknown {
  const [head, member] = path.split('.') as [keyof NoteDetail, string | undefined];
  const top = note[head];
  if (member === undefined) return top;
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    return (top as Record<string, unknown>)[member];
  }
  return undefined;
}

/** Render one field's VALUE. Booleans read as Yes/No — a technician does not want `true`. */
function fieldValueHtml(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return `<span class="unset">${esc(NOT_STATED)}</span>`;
  }
  if (typeof value === 'boolean') return esc(value ? 'Yes' : 'No');
  if (Array.isArray(value)) {
    const kept = (value as unknown[]).filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    if (kept.length === 0) return `<span class="unset">${esc(NOT_STATED)}</span>`;
    return kept.map((v) => `<span class="chip">${esc(v)}</span>`).join('');
  }
  // Anything that is not a string by here is a shape this renderer does not know how to show — an
  // object would stringify to "[object Object]" on a technician's screen. Fail safe to the muted
  // absence: telling a reviewer nothing was recorded is honest, and printing junk is not.
  if (typeof value !== 'string') return `<span class="unset">${esc(NOT_STATED)}</span>`;
  // The two NOT NULL enums say "not established" with the literal value 'unknown'; render that as
  // the same muted absence, so a reviewer sees one idea of "we don't know" rather than two.
  if (value === 'unknown') return `<span class="unset">${esc(NOT_STATED)}</span>`;
  return esc(humanizeLabel(value));
}

/**
 * The four verdict buttons for one field, plus the controlled-vocabulary `<select>` where one
 * exists. `aria-pressed` carries this reviewer's STANDING verdict.
 *
 * The 18 field paths absent from `NOTE_CORRECTABLE_VALUES` are free text and get NO input at all —
 * a reviewer may mark them wrong but may not retype them. That absence is the feature: it is what
 * keeps reviewer prose out of `note_feedback` (see `src/db/schemas/note-feedback.ts:16-21`).
 */
function verdictControls(
  path: NoteFieldPath,
  standing: string | undefined,
  corrected: string | null,
): string {
  const buttons = NOTE_FEEDBACK_VERDICTS.map(
    (v) =>
      `<button type="button" class="verdict v-${esc(v)}" data-field="${esc(path)}" data-verdict="${esc(v)}"` +
      ` aria-pressed="${standing === v ? 'true' : 'false'}" title="${esc(VERDICT_HINTS[v])}">` +
      `${esc(VERDICT_LABELS[v])}</button>`,
  ).join('');

  const allowed = NOTE_CORRECTABLE_VALUES[path];
  const select = allowed
    ? `<label class="correction"><span class="correction-label">Should have been</span>` +
      `<select data-correction="${esc(path)}">` +
      [`<option value="">(leave as recorded)</option>`]
        .concat(
          allowed.map(
            (o) =>
              `<option value="${esc(o)}"${o === corrected ? ' selected' : ''}>${esc(humanizeLabel(o))}</option>`,
          ),
        )
        .join('') +
      `</select></label>`
    : '';

  return `<div class="verdicts" data-field-row="${esc(path)}">${buttons}${select}</div>`;
}

/** One judgeable field: label, value, verdict controls. Unlike `cardField`, a null value is NEVER
 * omitted — on this screen absence is the finding, so it renders as muted "not stated on the call". */
function detailField(note: NoteDetail, path: NoteFieldPath, verdicts: VerdictMap): string {
  const standing = verdicts.get(path);
  return (
    `<div class="dfield" id="field-${esc(path)}">` +
    `<div class="dfield-head"><dt>${esc(FIELD_LABELS[path])}</dt>` +
    `<dd>${fieldValueHtml(valueAtPath(note, path))}</dd></div>` +
    verdictControls(path, standing?.verdict, standing?.corrected_enum_value ?? null) +
    `</div>`
  );
}

type VerdictMap = Map<string, { verdict: string; corrected_enum_value: string | null }>;

function verdictMap(dto: NoteDetail): VerdictMap {
  return new Map(
    dto.verdicts.map((v) => [
      v.field_path,
      { verdict: v.verdict, corrected_enum_value: v.corrected_enum_value },
    ]),
  );
}

/**
 * The running tally AND the caveat that keeps it honest, emitted together.
 *
 * They are one helper deliberately: the number invites being read as an accuracy rate, and it is
 * not one — a reviewer picks which fields to look at, so it is a self-selected sample of nothing.
 * Keeping the sentence in the same function as the figure means the two cannot drift apart in a
 * later edit, and `test/notes/` asserts both strings together.
 *
 * A tally of nothing says nothing, so at zero the block ships HIDDEN rather than announcing an
 * empty scoreboard on a page whose job is the note. It ships hidden rather than omitted so the
 * first verdict can reveal it in place — `detailScript` unhides it — instead of the figure only
 * appearing after a reload.
 */
function tallyBlock(tally: NoteTally): string {
  const { fields_checked: checked, marked_right: right } = tally;
  const headline =
    checked === 0
      ? ''
      : `You've checked ${checked} ${checked === 1 ? 'field' : 'fields'} across all notes at this version. ` +
        `You marked ${right} of them right (${Math.round((right / checked) * 100)}%).`;
  return (
    `<div class="tally"${checked === 0 ? ' hidden' : ''}>` +
    `<p class="tally-line">${esc(headline)}</p>` +
    `<p class="tally-caveat">This is a count of what you chose to look at, not an accuracy score.</p>` +
    `</div>`
  );
}

/* ==================================================================================================
 * Styles
 * ============================================================================================== */

/** Urgency → theme-token pill class. Its own `.note-urgency` class rather than reusing
 * `/knowledge`'s `.kb-urgency`: `src/ui/cards.ts` is explicit that cross-page selector ownership is
 * how this system breaks, and four duplicated rules are cheaper than two pages fighting over one. */
const URGENCY_PILL = new Map<string, string>(
  Object.entries({
    emergency: 'u-emergency',
    urgent: 'u-urgent',
    routine: 'u-routine',
  } satisfies Record<Urgency, string>),
);

function urgencyPill(urgency: string): string {
  const cls = URGENCY_PILL.get(urgency) ?? 'u-other';
  return `<span class="note-urgency ${cls}">${esc(humanizeLabel(urgency))}</span>`;
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  unreviewed: 'Not looked at',
  has_verdicts: 'Checked',
  has_wrong: 'Problems flagged',
};

function reviewStatePill(state: string): string {
  return `<span class="rstate rs-${esc(state)}">${esc(REVIEW_STATE_LABELS[state] ?? state)}</span>`;
}

const BASE_STYLE =
  THEME +
  `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text); }
main { max-width: var(--content-wide); margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 24px 0 8px; }
a { color: var(--accent); }
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
.table-wrap { border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
col.c-id { width: 130px; } col.c-time { width: 176px; } col.c-cat { width: 130px; }
col.c-urg { width: 100px; } col.c-state { width: 130px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top;
  font-size: 0.85rem; word-break: break-word; overflow-wrap: anywhere; }
th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--muted);
  font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.03em; box-shadow: inset 0 -1px 0 var(--border); }
tbody tr:hover { background: var(--panel-2); }
.pager { margin: 12px 0; display: flex; gap: 12px; align-items: center; }
.foot { margin-top: 24px; font-size: 0.8rem; color: var(--muted); }
.note-urgency { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px;
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
.note-urgency.u-emergency { background: var(--bad-bg); color: var(--bad-fg); }
.note-urgency.u-urgent { background: var(--warn-bg); color: var(--warn-fg); }
.note-urgency.u-routine { background: var(--ok-bg); color: var(--ok-fg); }
.note-urgency.u-other { background: var(--panel-3); color: var(--muted); }
.rstate { display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 6px;
  font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
.rstate.rs-unreviewed { background: var(--panel-3); color: var(--muted); }
.rstate.rs-has_verdicts { background: var(--info-bg); color: var(--info-fg); }
.rstate.rs-has_wrong { background: var(--bad-bg); color: var(--bad-fg); }
.tally { margin: 14px 0; padding: 12px 14px; border-radius: var(--radius); background: var(--panel-2);
  border: 1px solid var(--border); border-left: 3px solid var(--accent); }
.tally-line { margin: 0; font-size: 0.95rem; }
.tally-caveat { margin: 4px 0 0; font-size: 0.95rem; color: var(--muted); }
.unset { color: var(--muted); font-style: italic; }
`;

const LIST_STYLE =
  BASE_STYLE +
  CARD_STYLE +
  `
/* ---- Note-list card and filter chrome, on top of the shared card system above. ---- */
.note-summary-line { margin: 8px 0 0; font-size: 0.95rem; overflow-wrap: break-word; }
.note-summary-line.is-empty { color: var(--muted); font-style: italic; }
.note-more { margin: 10px 0 0; border-top: 1px solid var(--border); padding-top: 4px; }
.note-more > summary { cursor: pointer; min-height: 44px; padding: 12px 0; display: list-item;
  list-style-position: inside; color: var(--accent); font-size: 0.85rem; }
.card-actions { margin: 10px 0 0; }
.card-actions a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); text-decoration: none; }
.filters-mobile { display: none; }
.filters-mobile > summary { cursor: pointer; min-height: 44px; padding: 12px 14px; display: list-item;
  list-style-position: inside; background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius); font-weight: 600; font-size: 0.9rem; }
.filters-mobile[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
/* ---- The list page's OWN mobile block. A second @media with the same query is intentional: the
   shared one above already stacks the table into cards and sizes the generic form controls, and
   this one comes later so page-specific rules win where the two overlap. ---- */
@media (max-width: 899px) {
  .filters-desktop { display: none; }
  .filters-mobile { display: block; }
  .filters-mobile form.filters { border-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
  .filters-mobile .filters-label { display: none; }
}
`;

const DETAIL_STYLE =
  BASE_STYLE +
  `
main { max-width: var(--content); }
.summary-card { margin: 16px 0 8px; padding: 18px 20px; border-radius: var(--radius);
  background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); }
.summary-card .summary-kicker { margin: 0 0 8px; font-size: 0.72rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.summary-card .summary-body { margin: 0; font-size: 1.1rem; line-height: 1.55; overflow-wrap: break-word; }
.summary-card .summary-body.is-empty { color: var(--muted); font-style: italic; font-size: 1rem; }
.callmeta { margin: 0; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  font-size: 0.85rem; color: var(--muted); }
.dfield { padding: 12px 0; border-bottom: 1px solid var(--border); }
.dfield-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.dfield-head dt { color: var(--muted); font-size: 0.78rem; min-width: 220px; }
.dfield-head dd { margin: 0; font-size: 0.95rem; flex: 1 1 240px; overflow-wrap: break-word; }
.chip { display: inline-block; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 6px; padding: 2px 8px; margin: 0 6px 6px 0; font-size: 0.85rem; }
.verdicts { margin: 8px 0 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button.verdict { font: inherit; font-size: 0.8rem; min-height: 36px; padding: 4px 14px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); cursor: pointer; }
button.verdict:hover { background: var(--panel-3); color: var(--text); }
button.verdict[aria-pressed="true"] { color: var(--text); font-weight: 700; border-color: var(--border-2); }
button.verdict.v-correct[aria-pressed="true"] { background: var(--ok-bg); color: var(--ok-fg); }
button.verdict.v-wrong[aria-pressed="true"],
button.verdict.v-should_not_be_here[aria-pressed="true"] { background: var(--bad-bg); color: var(--bad-fg); }
button.verdict.v-missing[aria-pressed="true"] { background: var(--warn-bg); color: var(--warn-fg); }
label.correction { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--muted); }
label.correction select { font: inherit; font-size: 0.8rem; min-height: 36px; padding: 4px 8px;
  border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
.gaps { margin: 0; padding: 0; list-style: none; }
.gaps li { padding: 6px 0; }
.gaps .none { color: var(--muted); font-style: italic; }
.transcript-open { font: inherit; min-height: 44px; padding: 10px 18px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--panel-3); color: var(--text); cursor: pointer;
  font-weight: 600; margin: 20px 0 0; }
.transcript-open:hover { background: var(--border); }
#result { margin: 10px 0 0; font-size: 0.85rem; color: var(--muted); min-height: 1.2em; }
/* ---- The transcript modal. Native <dialog>: it brings the focus trap, Escape-to-close, and the
   top-layer stacking that a hand-rolled div overlay has to reimplement badly. ---- */
dialog.transcript { width: min(760px, 92vw); max-height: 82vh; padding: 0; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--panel); color: var(--text); overflow: hidden; }
dialog.transcript::backdrop { background: rgba(0, 0, 0, 0.66); }
dialog.transcript .dlg-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px;
  border-bottom: 1px solid var(--border); }
dialog.transcript .dlg-head h2 { margin: 0; font-size: 1rem; }
dialog.transcript .dlg-close { margin-left: auto; font: inherit; min-height: 40px; min-width: 40px;
  padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2);
  color: var(--text); cursor: pointer; }
dialog.transcript .dlg-close:hover { background: var(--panel-3); }
dialog.transcript .dlg-note { margin: 0; padding: 10px 16px; font-size: 0.82rem; color: var(--muted);
  border-bottom: 1px solid var(--border); background: var(--panel-2); }
dialog.transcript .dlg-body { padding: 14px 16px; overflow-y: auto; max-height: calc(82vh - 150px); }
.turn { margin: 0 0 12px; }
.turn .who { display: block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.04em; color: var(--accent); margin-bottom: 2px; }
.turn .said { margin: 0; font-size: 0.92rem; overflow-wrap: break-word; white-space: pre-wrap; }
.turn.no-speaker .said { color: var(--text); }
.dlg-message { margin: 0; font-size: 0.92rem; color: var(--muted); }
@media (max-width: 899px) {
  main { max-width: 640px; padding: 12px 12px 24px; }
  h1 { font-size: 1.25rem; }
  .dfield-head dt { min-width: 0; flex-basis: 100%; }
  button.verdict { min-height: 44px; font-size: 0.85rem; }
  label.correction select { min-height: 44px; font-size: 16px; }
  dialog.transcript { width: 100vw; max-width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; }
  dialog.transcript .dlg-body { max-height: calc(100vh - 160px); }
}
`;

/* ==================================================================================================
 * List page
 * ============================================================================================== */

function filterQuery(f: NoteFilters): string {
  const p = new URLSearchParams();
  if (f.service_category) p.set('service_category', f.service_category);
  if (f.urgency) p.set('urgency', f.urgency);
  if (f.review_state) p.set('review_state', f.review_state);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function activeFilterCount(f: NoteFilters): number {
  return [f.service_category, f.urgency, f.review_state, f.from, f.to].filter(
    (v) => v !== undefined && v !== '',
  ).length;
}

function selectField(
  name: string,
  label: string,
  options: readonly string[],
  selected: string | undefined,
  optionLabel: (o: string) => string = humanizeLabel,
): string {
  const opts = [`<option value="">Any</option>`]
    .concat(
      options.map(
        (o) =>
          `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(optionLabel(o))}</option>`,
      ),
    )
    .join('');
  return `<label>${esc(label)}<select name="${esc(name)}">${opts}</select></label>`;
}

function noteHref(callId: string): string {
  return `/notes/${encodeURIComponent(callId)}`;
}

function rowHtml(r: NoteListItem): string {
  const summary = r.dispatch_summary_first_line;
  return (
    `<tr>` +
    `<td><a class="mono" href="${esc(noteHref(r.call_id))}" title="${esc(r.call_id)}">${esc(r.call_id)}</a></td>` +
    `<td class="mono" title="${esc(r.created_at)}">${esc(fmtCreatedCt(r.created_at))}</td>` +
    `<td>${esc(humanizeLabel(r.service_category))}</td>` +
    `<td>${urgencyPill(r.urgency)}</td>` +
    `<td>${reviewStatePill(r.review_state)}</td>` +
    `<td>${summary ? esc(summary) : `<span class="unset">No dispatch summary was written.</span>`}</td>` +
    `</tr>`
  );
}

function cardHtml(r: NoteListItem): string {
  const summary = r.dispatch_summary_first_line;
  const summaryHtml = summary
    ? `<p class="note-summary-line">${esc(summary)}</p>`
    : `<p class="note-summary-line is-empty">No dispatch summary was written.</p>`;

  const blocks =
    cardField('Review state', REVIEW_STATE_LABELS[r.review_state] ?? r.review_state) +
    cardField(
      'Not confirmed on this call',
      r.not_established_count === 0
        ? 'Nothing outstanding'
        : `${r.not_established_count} ${r.not_established_count === 1 ? 'field' : 'fields'}`,
    ) +
    `<div class="field"><dt>Call</dt><dd class="mono" title="${esc(r.call_id)}">${esc(r.call_id)}</dd></div>`;

  const cardLabel = `${humanizeLabel(r.urgency)} ${humanizeLabel(r.service_category)} call, ${fmtCreatedCt(r.created_at)}`;

  return (
    `<article class="card" aria-label="${esc(cardLabel)}">` +
    `<div class="card-head"><time datetime="${esc(r.created_at)}">${esc(fmtCreatedCt(r.created_at))}</time>` +
    `${urgencyPill(r.urgency)}</div>` +
    `<p class="card-meta">${esc(humanizeLabel(r.service_category))}</p>` +
    summaryHtml +
    `<details class="note-more"><summary>More details</summary><dl class="fields">${blocks}</dl></details>` +
    `<p class="card-actions"><a href="${esc(noteHref(r.call_id))}">Review this note</a></p>` +
    `</article>`
  );
}

const COLGROUP =
  `<colgroup><col class="c-id"><col class="c-time"><col class="c-cat">` +
  `<col class="c-urg"><col class="c-state"><col></colgroup>`;

const REVIEW_STATE_OPTIONS = ['unreviewed', 'has_verdicts', 'has_wrong'] as const;

export function renderNotesListPage(dto: NoteList, chrome: Chrome = {}): string {
  const f = dto.filters;
  const qs = filterQuery(f);

  const form =
    `<form class="filters" method="get" action="/notes">` +
    `<span class="filters-label">Filters</span>` +
    selectField('service_category', 'Service category', SERVICE_CATEGORIES, f.service_category) +
    selectField('urgency', 'Urgency', URGENCY, f.urgency) +
    selectField(
      'review_state',
      'Review state',
      REVIEW_STATE_OPTIONS,
      f.review_state,
      (o) => REVIEW_STATE_LABELS[o] ?? o,
    ) +
    `<label>From<input type="text" name="from" value="${esc(f.from ?? '')}" placeholder="YYYY-MM-DD"></label>` +
    `<label>To<input type="text" name="to" value="${esc(f.to ?? '')}" placeholder="YYYY-MM-DD"></label>` +
    `<button type="submit">Search</button>` +
    `</form>`;

  const activeCount = activeFilterCount(f);
  const filtersBlock =
    `<div class="filters-desktop">${form}</div>` +
    `<details class="filters-mobile"${activeCount > 0 ? ' open' : ''}>` +
    `<summary>${activeCount === 0 ? 'Filters' : `Filters &middot; ${esc(String(activeCount))} active`}</summary>` +
    `${form}</details>`;

  const header = `<tr>${[
    'Call',
    'Call date',
    'Category',
    'Urgency',
    'Review state',
    'Dispatch summary',
  ]
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr>`;
  const table =
    `<div class="table-wrap table-scroll"><table>${COLGROUP}<thead>${header}</thead>` +
    `<tbody>${dto.results.map(rowHtml).join('')}</tbody></table></div>`;
  const cards = `<div class="cards">${dto.results.map(cardHtml).join('')}</div>`;

  const prevHref = dto.page > 1 ? esc(`/notes${qs ? `${qs}&` : '?'}page=${dto.page - 1}`) : '';
  const nextHref =
    dto.page < dto.total_pages ? esc(`/notes${qs ? `${qs}&` : '?'}page=${dto.page + 1}`) : '';
  const pager =
    `<div class="pager">` +
    (prevHref ? `<a href="${prevHref}">&larr; Prev</a>` : '<span></span>') +
    `<span>Page ${esc(String(dto.page))} of ${esc(String(dto.total_pages))} · ${esc(String(dto.total))} total</span>` +
    (nextHref ? `<a href="${nextHref}">Next &rarr;</a>` : '<span></span>') +
    `</div>`;
  const pagerBottom = pager.replace('<div class="pager">', '<div class="pager pager-bottom">');

  const empty =
    dto.results.length === 0 ? `<p class="unset">No technician notes match these filters.</p>` : '';

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Technician notes</title><style>${LIST_STYLE}</style></head><body>` +
    siteHeader('Technician notes') +
    `<main>` +
    `<h1>Technician notes</h1>` +
    `<p class="muted">The note a technician would receive for each call. Open one to say whether it is right.</p>` +
    filtersBlock +
    tallyBlock(dto.tally) +
    pager +
    empty +
    table +
    cards +
    pagerBottom +
    `<p class="foot">Verdicts are recorded against note version ${esc(dto.tally.note_prompt_version)}. Notes are never changed by a review.</p>` +
    `</main>` +
    logoutScript(chrome) +
    filtersScript(chrome) +
    `</body></html>`
  );
}

/* ==================================================================================================
 * Detail page + transcript modal
 * ============================================================================================== */

/**
 * The nonce'd inline script for the detail page. Two jobs: post a verdict, and drive the transcript
 * dialog.
 *
 * NO inline event handler attributes anywhere — every binding is `addEventListener` on a
 * `data-*`-marked element, the convention `src/review/render.ts` already uses, because a strict CSP
 * blocks `onclick=` and we would rather the page not depend on one.
 *
 * Dismissal converges by design: the close BUTTON and the backdrop both call `dlg.close()`, and
 * `<dialog>` fires `close` for those AND for Escape — so all three routes end in the single `close`
 * listener, which is the only place that restores focus and unlocks scrolling. They cannot drift
 * apart because there is only one of them.
 */
function detailScript(dto: NoteDetail, chrome: Chrome): string {
  return (
    `<script nonce="${esc(chrome.nonce ?? '')}">` +
    `(function(){` +
    `var CSRF=${jsonForScript(chrome.csrfToken ?? '')};` +
    `var CALL=${jsonForScript(dto.call_id)};` +
    `var out=document.getElementById('result');` +
    `var dlg=document.getElementById('transcript');` +
    `var body=document.getElementById('transcript-body');` +
    `var opener=document.getElementById('open-transcript');` +
    `var closeBtn=document.getElementById('close-transcript');` +
    `var lastTrigger=null;var loaded=false;` +
    // --- verdicts -------------------------------------------------------------------------
    // The zero case has no sentence: the block stays hidden until there is a figure to show, the
    // same rule `tallyBlock` applies server-side. One idea, two places, deliberately identical.
    `function applyTally(t){var line=document.querySelector('.tally-line');if(!line){return;}` +
    `var box=line.closest('.tally');` +
    `if(!t||t.fields_checked===0){line.textContent='';if(box){box.setAttribute('hidden','');}return;}` +
    `var pct=Math.round((t.marked_right/t.fields_checked)*100);` +
    `line.textContent="You've checked "+t.fields_checked+" "+(t.fields_checked===1?"field":"fields")+` +
    `" across all notes at this version. You marked "+t.marked_right+" of them right ("+pct+"%).";` +
    `if(box){box.removeAttribute('hidden');}}` +
    `document.querySelectorAll('button.verdict').forEach(function(b){` +
    `b.addEventListener('click',async function(){` +
    `var path=b.dataset.field;var row=document.querySelector('[data-field-row="'+path+'"]');` +
    `var sel=row?row.querySelector('select[data-correction]'):null;` +
    `var payload={field_path:path,verdict:b.dataset.verdict};` +
    `if(sel&&sel.value){payload.corrected_enum_value=sel.value;}` +
    `out.textContent='Saving\\u2026';` +
    `try{var r=await fetch('/notes/'+encodeURIComponent(CALL)+'/feedback',{method:'POST',` +
    `headers:{'content-type':'application/json','X-CSRF-Token':CSRF},body:JSON.stringify(payload)});` +
    `if(!r.ok){out.textContent='Could not save that (error '+r.status+'). Nothing was recorded.';return;}` +
    `var j=await r.json();` +
    `if(row){row.querySelectorAll('button.verdict').forEach(function(o){` +
    `o.setAttribute('aria-pressed',o.dataset.verdict===j.verdict.verdict?'true':'false');});}` +
    `applyTally(j.tally);` +
    `out.textContent='Saved.';` +
    `}catch(e){out.textContent='Network error \\u2014 nothing was recorded. Please try again.';}});});` +
    // --- transcript modal -----------------------------------------------------------------
    `function turn(who,said){var d=document.createElement('div');d.className=who?'turn':'turn no-speaker';` +
    `if(who){var w=document.createElement('span');w.className='who';w.textContent=who;d.appendChild(w);}` +
    `var p=document.createElement('p');p.className='said';p.textContent=said;d.appendChild(p);return d;}` +
    `function message(text){var p=document.createElement('p');p.className='dlg-message';p.textContent=text;return p;}` +
    `function render(j){body.textContent='';` +
    `if(!j.available){body.appendChild(message(j.reason==='withheld'` +
    `?"We're not showing this transcript. An automatic check found something that may be personal information still in the text, so it's held back."` +
    `:"The redacted transcript for this call is no longer stored, so there's nothing to show. The note is still what the system produced at the time."));return;}` +
    `var lines=j.redacted_text.split('\\n');var any=false;` +
    `lines.forEach(function(l){if(!l.trim()){return;}any=true;` +
    `var m=/^([^:]{1,40}):\\s*([\\s\\S]*)$/.exec(l);` +
    `body.appendChild(m?turn(m[1],m[2]):turn('',l));});` +
    `if(!any){body.appendChild(message('The stored transcript is empty.'));}}` +
    `async function load(){body.textContent='';body.appendChild(message('Loading the transcript\\u2026'));` +
    `try{var r=await fetch('/notes/'+encodeURIComponent(CALL)+'/transcript.json',{headers:{'Accept':'application/json'}});` +
    `if(!r.ok){body.textContent='';body.appendChild(message('The transcript could not be loaded (error '+r.status+').'));return;}` +
    `render(await r.json());loaded=true;` +
    `}catch(e){body.textContent='';body.appendChild(message('The transcript could not be loaded. Please try again.'));}}` +
    `if(opener&&dlg){opener.addEventListener('click',function(){lastTrigger=opener;` +
    `document.body.style.overflow='hidden';dlg.showModal();if(!loaded){load();}});}` +
    `if(closeBtn&&dlg){closeBtn.addEventListener('click',function(){dlg.close();});}` +
    // Backdrop: a click whose target IS the dialog element landed outside the content box.
    `if(dlg){dlg.addEventListener('click',function(e){if(e.target===dlg){dlg.close();}});}` +
    // The ONE dismissal path — close button, backdrop, and Escape all arrive here.
    `if(dlg){dlg.addEventListener('close',function(){document.body.style.overflow='';` +
    `if(lastTrigger){lastTrigger.focus();lastTrigger=null;}});}` +
    `})();` +
    `</script>`
  );
}

function gapsBlock(dto: NoteDetail, verdicts: VerdictMap): string {
  const items =
    dto.not_established.length === 0
      ? `<li class="none">Nothing outstanding — everything a dispatcher needs was established on the call.</li>`
      : dto.not_established
          .map((path) => {
            const label = FIELD_LABELS[path as NoteFieldPath] ?? humanizeLabel(path);
            return `<li>${esc(label)}</li>`;
          })
          .join('');
  return (
    `<h2>Not confirmed on this call</h2>` +
    `<p class="muted">The note reports these were never established. Judge whether that is true.</p>` +
    `<ul class="gaps">${items}</ul>` +
    `<div class="dfield">` +
    verdictControls(
      'not_established',
      verdicts.get('not_established')?.verdict,
      verdicts.get('not_established')?.corrected_enum_value ?? null,
    ) +
    `</div>`
  );
}

export function renderNoteDetailPage(dto: NoteDetail, chrome: Chrome = {}): string {
  const verdicts = verdictMap(dto);

  const summaryBody = dto.dispatch_summary
    ? `<p class="summary-body">${esc(dto.dispatch_summary)}</p>`
    : `<p class="summary-body is-empty">No dispatch summary was written for this call.</p>`;

  const summaryCard =
    `<section class="summary-card">` +
    `<p class="summary-kicker">What the technician receives</p>` +
    summaryBody +
    verdictControls(
      'dispatch_summary',
      verdicts.get('dispatch_summary')?.verdict,
      verdicts.get('dispatch_summary')?.corrected_enum_value ?? null,
    ) +
    `</section>`;

  const groups = FIELD_GROUPS.map(
    (g) =>
      `<h2>${esc(g.heading)}</h2>` +
      `<dl class="dfields">${g.paths.map((p) => detailField(dto, p, verdicts)).join('')}</dl>`,
  ).join('');

  const modal =
    `<dialog class="transcript" id="transcript" aria-labelledby="transcript-title">` +
    `<div class="dlg-head"><h2 id="transcript-title">Call transcript</h2>` +
    `<button type="button" class="dlg-close" id="close-transcript">Close</button></div>` +
    `<p class="dlg-note">This is the version the system read, with personal details removed.</p>` +
    `<div class="dlg-body" id="transcript-body"></div>` +
    `</dialog>`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Technician note</title><style>${DETAIL_STYLE}</style></head><body>` +
    siteHeader('Technician notes') +
    `<main>` +
    `<p class="nav"><a href="/notes">&larr; All notes</a></p>` +
    `<h1>Technician note</h1>` +
    `<p class="callmeta">${urgencyPill(dto.urgency)}` +
    `<span>${esc(humanizeLabel(dto.service_category))}</span>` +
    `<span class="mono" title="${esc(dto.created_at)}">${esc(fmtCreatedCt(dto.created_at))}</span>` +
    `<span class="mono" title="${esc(dto.call_id)}">${esc(dto.call_id)}</span></p>` +
    summaryCard +
    // Directly under the summary, not at the foot of the page: judging the summary means checking
    // it against the call, so the way to hear the call belongs beside it rather than forty
    // judgeable fields away.
    `<button type="button" class="transcript-open" id="open-transcript">View full transcript</button>` +
    tallyBlock(dto.tally) +
    `<div id="result" aria-live="polite"></div>` +
    groups +
    gapsBlock(dto, verdicts) +
    `<p class="foot">Judging note version ${esc(dto.prompt_version)}. A verdict is recorded against that version and never changes the note.</p>` +
    `</main>` +
    modal +
    logoutScript(chrome) +
    detailScript(dto, chrome) +
    `</body></html>`
  );
}

/**
 * The page for a call that has no note. An explanation, not an error: a call can legitimately lack
 * one (the generator counts a missing clean transcript as a SKIP), and a 404 would tell the reader
 * they did something wrong when they did not.
 */
export function renderNoteMissingPage(chrome: Chrome = {}): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Technician note</title><style>${DETAIL_STYLE}</style></head><body>` +
    siteHeader('Technician notes') +
    `<main>` +
    `<p class="nav"><a href="/notes">&larr; All notes</a></p>` +
    `<h1>No note for this call</h1>` +
    `<p>There is no technician note for this call. That usually means the redacted transcript ` +
    `was not available when notes were generated, so there was nothing to write one from.</p>` +
    `<p class="muted">Nothing is wrong, and there is nothing to review here.</p>` +
    `</main>` +
    logoutScript(chrome) +
    `</body></html>`
  );
}
