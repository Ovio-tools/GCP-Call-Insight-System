import { describe, expect, it } from 'vitest';
import {
  catalogFor,
  createFailure,
  dedupKey,
  formatAlert,
  renderAlertText,
  severityFor,
} from '../../src/failure-model/index.js';
import { GOLDEN_OPTS } from './fixtures/sample-errors.js';

/**
 * VERBATIM_PII_DETECTED (Task 5.2): the extract stage's second PII scan found possible
 * residual PII in a model-extracted verbatim marketing phrase. This is a POST-extraction
 * hit — the redacted transcript already crossed to Anthropic, so the alert must never
 * claim data is definitely safe, and its wording must not reuse the pre-egress
 * redaction-hold phrasing.
 */

function verbatimPiiFailure() {
  return createFailure('VERBATIM_PII_DETECTED', {
    processingState: 'continuing',
    context: { call_id: 'c-1', environment: 'staging' },
  });
}

describe('VERBATIM_PII_DETECTED', () => {
  it('renders the complete plain-language alert contract', () => {
    const formatted = formatAlert(verbatimPiiFailure(), GOLDEN_OPTS);

    // What broke / likely root cause (1:1 category).
    expect(formatted.whatBroke).toBe('VERBATIM_PII_DETECTED');
    expect(formatted.likelyRootCause).toBe('VERBATIM_PII_DETECTED');
    // Impact, immediate remediation, longer-term fix — all real text.
    expect(formatted.impact.length).toBeGreaterThan(0);
    expect(formatted.immediateRemediation.length).toBeGreaterThan(0);
    expect(formatted.longerTermFix.length).toBeGreaterThan(0);
    // Data-safe / calls-held / runbook / timestamp / environment.
    expect(typeof formatted.dataSafe).toBe('boolean');
    expect(formatted.callsState).toBe('held');
    expect(formatted.runbookRef).toBe('runbook#verbatim-pii-detected');
    expect(formatted.timestamp).toBe(GOLDEN_OPTS.timestamp);
    expect(formatted.environment).toBe(GOLDEN_OPTS.environment);
    expect(formatted.affectedScope).toEqual(['call_id', 'environment']);
  });

  it('is NOT data-safe: the phrase may already have crossed to Anthropic', () => {
    expect(catalogFor('VERBATIM_PII_DETECTED').dataSafe).toBe(false);
    expect(verbatimPiiFailure().data_safe).toBe(false);
    const text = renderAlertText(verbatimPiiFailure(), GOLDEN_OPTS);
    expect(text).toContain('Customer data safe: no');
  });

  it('never claims nothing was stored or that data is definitely safe', () => {
    const entry = catalogFor('VERBATIM_PII_DETECTED');
    const rendered = renderAlertText(verbatimPiiFailure(), GOLDEN_OPTS).toLowerCase();
    const catalogText = [entry.impact, entry.remediationNow, entry.remediationFix]
      .join(' ')
      .toLowerCase();
    for (const forbidden of [
      'nothing was stored',
      'never persisted',
      'never stored',
      'data is safe',
      'no data was leaked',
    ]) {
      expect(rendered).not.toContain(forbidden);
      expect(catalogText).not.toContain(forbidden);
    }
  });

  it('uses post-extraction wording, not the pre-egress redaction-hold phrasing', () => {
    const entry = catalogFor('VERBATIM_PII_DETECTED');
    const redactionEntry = catalogFor('REDACTION_LOW_CONFIDENCE');
    expect(entry.impact).not.toBe(redactionEntry.impact);
    // The pre-egress holds promise the text was never sent; a post-extraction hit cannot.
    expect(entry.impact.toLowerCase()).not.toContain('never sent');
    // It must name the extracted verbatim phrase as the subject.
    expect(entry.impact.toLowerCase()).toContain('verbatim');
    expect(entry.impact.toLowerCase()).toContain('extract');
  });

  it('remediation includes the was-it-egressed check and the corpus/prompt fix', () => {
    const entry = catalogFor('VERBATIM_PII_DETECTED');
    expect(entry.remediationNow.toLowerCase()).toContain('redacted transcript');
    expect(entry.remediationNow.toLowerCase()).toContain('same value');
    expect(entry.remediationFix.toLowerCase()).toContain('deny list');
  });

  it('holds the call and defaults to high severity', () => {
    expect(catalogFor('VERBATIM_PII_DETECTED').callsState).toBe('held');
    expect(severityFor('VERBATIM_PII_DETECTED')).toBe('high');
  });

  it('has a stable dedup key of the same shape as other codes', () => {
    const a = dedupKey(verbatimPiiFailure());
    const b = dedupKey(verbatimPiiFailure());
    expect(a).toBe(b);
    expect(a).toBe('VERBATIM_PII_DETECTED:call_id:c-1');
    expect(
      dedupKey(createFailure('VERBATIM_PII_DETECTED', { processingState: 'continuing' })),
    ).toBe('VERBATIM_PII_DETECTED:global');
  });
});
