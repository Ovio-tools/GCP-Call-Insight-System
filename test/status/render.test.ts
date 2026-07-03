import { describe, expect, it } from 'vitest';
import { STAGE_NODES, COMPONENT_NODES } from '../../src/status/stages.js';
import { renderStatusPage } from '../../src/status/render.js';
import { makeStatusDto } from './_fixture.js';

describe('renderStatusPage', () => {
  it('renders every stage + component label with a state word', () => {
    const html = renderStatusPage(makeStatusDto());
    for (const n of STAGE_NODES) expect(html).toContain(n.label);
    for (const c of COMPONENT_NODES) expect(html).toContain(c.label);
    // State text present, not color-only.
    expect(html).toContain('Idle');
    expect(html).toContain('Healthy');
  });

  it('is mobile-first: viewport meta + capped-width single column', () => {
    const html = renderStatusPage(makeStatusDto());
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('max-width');
  });

  it('emits a refresh meta only when refreshSeconds > 0', () => {
    expect(renderStatusPage(makeStatusDto(), { refreshSeconds: 30 })).toContain(
      '<meta http-equiv="refresh" content="30">',
    );
    expect(renderStatusPage(makeStatusDto(), { refreshSeconds: 0 })).not.toContain(
      'http-equiv="refresh"',
    );
    expect(renderStatusPage(makeStatusDto())).not.toContain('http-equiv="refresh"');
  });

  it('renders the word "unknown" (not 0) for a null metric', () => {
    const html = renderStatusPage(
      makeStatusDto((d) => {
        d.summary.calls_processed_today = null;
        d.summary.spend.spent_usd = null;
        d.summary.spend.model_paused = null;
      }),
    );
    expect(html).toContain('unknown');
    // The processed-today tile must not read 0 when the metric is unknown.
    expect(html).toMatch(/Processed today<\/div><div class="v">unknown/);
  });

  it('shows the held-for-review breakdown and dead-letter section', () => {
    const html = renderStatusPage(makeStatusDto());
    expect(html).toContain('Held for review');
    expect(html).toContain('missing_transcript');
    expect(html).toContain('classified_spam');
    expect(html).toContain('Dead-letter');
  });

  it('surfaces the broken cause in the summary sentence', () => {
    const html = renderStatusPage(
      makeStatusDto((d) => {
        d.summary.pipeline_state = 'broken';
        d.summary.latest_issue = {
          error_code: 'DATABASE_UNAVAILABLE',
          root_cause_category: 'DATABASE_UNAVAILABLE',
          severity: 'critical',
          summary: 'Postgres is unreachable; processing is paused.',
          runbook_ref: 'runbook#db',
          at: '2026-07-01T11:55:00.000Z',
        };
      }),
    );
    expect(html).toContain('Pipeline is broken: Postgres is unreachable');
  });

  it('escapes HTML-significant characters in interpolated values', () => {
    const html = renderStatusPage(
      makeStatusDto((d) => {
        d.summary.pipeline_state = 'degraded';
        d.summary.latest_issue = {
          error_code: 'X',
          root_cause_category: 'X',
          severity: 'medium',
          summary: '<script>alert(1)</script>',
          runbook_ref: 'r',
          at: '2026-07-01T11:55:00.000Z',
        };
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
