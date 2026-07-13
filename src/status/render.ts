import type { ComponentNode, StageNode, StatusDTO } from './dto.js';

/**
 * Server-rendered, self-contained status page (Task 7.3, plan §5). Inline CSS, no external
 * assets, no fetch/streaming, no JS beyond an optional `<meta http-equiv=refresh>` (load/
 * refresh only — never a per-call animation or execution trace). Mobile-first: single column,
 * capped width, large tap targets, readable at 360px.
 *
 * EVERY interpolated value is HTML-escaped, even though labels/states/counts are enums or
 * numbers — defense against injection and any accidental raw-content bleed. The DTO is
 * already the allowlist (plan §4), so nothing but labels/states/counts/summary strings can be
 * placed here.
 */
export interface RenderStatusOptions {
  /** `<meta http-equiv=refresh>` cadence in seconds; 0 (or absent) disables auto-refresh. */
  refreshSeconds?: number;
}

/** Escape the five HTML-significant characters. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A null count reads as the word `unknown`; a real 0 stays `0`. */
function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined ? 'unknown' : String(n);
}

function fmtUsd(n: number | null): string {
  return n === null ? 'unknown' : `$${n.toFixed(2)}`;
}

/** Human word for a nullable boolean pause flag (unknown, never `false`, when null). */
function fmtPaused(p: boolean | null): string {
  if (p === null) return 'unknown';
  return p ? 'paused' : 'active';
}

const STATE_WORD: Record<string, string> = {
  healthy: 'Healthy',
  idle: 'Idle',
  degraded: 'Degraded',
  broken: 'Broken',
  paused: 'Paused',
  unknown: 'Unknown',
  running: 'Running',
};

function stateWord(state: string): string {
  return STATE_WORD[state] ?? state;
}

/** The plain-language one-sentence summary at the top of the page. */
function summarySentence(dto: StatusDTO): string {
  const s = dto.summary;
  const cause = s.latest_issue ? s.latest_issue.summary : '';
  switch (s.pipeline_state) {
    case 'running':
      return 'Pipeline is running.';
    case 'degraded':
      return `Pipeline is degraded${cause ? `: ${cause}` : '.'}`;
    case 'broken':
      return `Pipeline is broken${cause ? `: ${cause}` : '.'}`;
    case 'paused':
      return 'Pipeline is paused: model steps are not running.';
    default:
      return 'Pipeline status is unknown — some health signals are unavailable.';
  }
}

function stageNodeHtml(node: StageNode): string {
  return (
    `<li class="node state-${esc(node.state)}">` +
    `<span class="node-label">${esc(node.label)}</span>` +
    `<span class="node-meta"><span class="state">${esc(stateWord(node.state))}</span>` +
    `<span class="count">${esc(fmtCount(node.count))}</span></span>` +
    `</li>`
  );
}

function componentNodeHtml(node: ComponentNode): string {
  const last = node.last_run_at ? `last run ${esc(node.last_run_at)}` : 'no liveness signal';
  return (
    `<li class="node state-${esc(node.state)}">` +
    `<span class="node-label">${esc(node.label)}</span>` +
    `<span class="node-meta"><span class="state">${esc(stateWord(node.state))}</span>` +
    `<span class="last-run">${last}</span></span>` +
    `</li>`
  );
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f1216; color: #e7ecf2; }
main { max-width: 640px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 24px 0 8px; }
a { color: #93c5fd; }
.nav { margin: 0 0 12px; font-size: 0.85rem; }
.summary { font-size: 1.1rem; margin: 8px 0 16px; padding: 12px; border-radius: 10px;
  background: #1a2029; border: 1px solid #2a323d; }
.counts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0 8px; }
.counts .tile { background: #1a2029; border: 1px solid #2a323d; border-radius: 10px; padding: 10px 12px; }
.counts .tile .k { font-size: 0.8rem; opacity: 0.75; }
.counts .tile .v { font-size: 1.3rem; font-weight: 600; }
ul.nodes { list-style: none; padding: 0; margin: 0; }
.node { display: flex; justify-content: space-between; align-items: center; gap: 8px;
  min-height: 48px; padding: 10px 12px; margin: 6px 0; border-radius: 10px;
  border: 1px solid #2a323d; background: #161b22; }
.node .node-label { font-weight: 600; }
.node .node-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
  text-align: right; }
.node .state { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
  padding: 2px 8px; border-radius: 999px; }
.node .count { font-variant-numeric: tabular-nums; opacity: 0.85; }
.node .last-run { font-size: 0.75rem; opacity: 0.7; word-break: break-word; }
.arrow { text-align: center; opacity: 0.5; line-height: 1; margin: -2px 0; }
.state-healthy .state { background: #10391f; color: #7ee2a8; }
.state-idle .state { background: #22303f; color: #93c5fd; }
.state-degraded .state { background: #3f3410; color: #f5d67b; }
.state-broken .state { background: #401a1a; color: #f6a5a5; }
.state-paused .state { background: #2f2740; color: #cbb6f2; }
.state-unknown .state { background: #262c34; color: #b7c0cc; }
.reasons { list-style: none; padding: 0; margin: 0; }
.reasons li { display: flex; justify-content: space-between; padding: 8px 12px; margin: 4px 0;
  background: #161b22; border: 1px solid #2a323d; border-radius: 8px; }
.foot { margin-top: 24px; font-size: 0.8rem; opacity: 0.7; }
a { color: #93c5fd; }
`;

export function renderStatusPage(dto: StatusDTO, opts: RenderStatusOptions = {}): string {
  const s = dto.summary;
  const refresh =
    opts.refreshSeconds && opts.refreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${esc(String(Math.floor(opts.refreshSeconds)))}">`
      : '';

  // Vertical stage list with arrows between nodes.
  const stagesHtml = dto.pipeline_nodes
    .map(
      (n, i) => (i === 0 ? '' : '<div class="arrow" aria-hidden="true">↓</div>') + stageNodeHtml(n),
    )
    .join('');

  const componentsHtml = dto.components.map(componentNodeHtml).join('');

  const heldBreakdown =
    s.held_by_reason === null
      ? '<p>Held-for-review breakdown is <strong>unknown</strong>.</p>'
      : s.held_by_reason.length === 0
        ? '<p>No calls are currently held for review.</p>'
        : `<ul class="reasons">${s.held_by_reason
            .map(
              (r) =>
                `<li><span>${esc(r.held_reason)}</span><span>${esc(String(r.count))}</span></li>`,
            )
            .join('')}</ul>`;

  const spend = `${esc(fmtUsd(s.spend.spent_usd))} / ${esc(fmtUsd(s.spend.budget_usd))} (model ${esc(
    fmtPaused(s.spend.model_paused),
  )})`;

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    refresh +
    `<title>Pipeline status</title><style>${STYLE}</style></head><body><main>` +
    `<p class="nav"><a href="/">&larr; Home</a></p>` +
    `<h1>Pipeline status</h1>` +
    `<p class="nav"><a href="/calls">View all calls &amp; outcomes &rarr;</a></p>` +
    `<p class="summary state-${esc(s.pipeline_state)}">${esc(summarySentence(dto))}</p>` +
    `<div class="counts">` +
    `<div class="tile"><div class="k">Processed today</div><div class="v">${esc(fmtCount(s.calls_processed_today))}</div></div>` +
    `<div class="tile"><div class="k">Held for review</div><div class="v">${esc(fmtCount(s.calls_held_for_review))}</div></div>` +
    `<div class="tile"><div class="k">Dead-letter</div><div class="v">${esc(fmtCount(s.dead_letter_count))}</div></div>` +
    `<div class="tile"><div class="k">Spend vs budget</div><div class="v">${spend}</div></div>` +
    `</div>` +
    `<h2>Pipeline stages</h2><ul class="nodes">${stagesHtml}</ul>` +
    `<h2>Components</h2><ul class="nodes">${componentsHtml}</ul>` +
    `<h2>Held for review</h2>${heldBreakdown}` +
    `<h2>Dead-letter</h2><p>${esc(fmtCount(s.dead_letter_count))} job(s) in the dead-letter queue.</p>` +
    `<p class="foot">Generated at ${esc(dto.generated_at)}. <a href="">Refresh</a></p>` +
    `</main></body></html>`
  );
}
