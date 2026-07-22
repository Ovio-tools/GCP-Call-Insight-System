import { describe, expect, it } from 'vitest';
import {
  type FailureFields,
  ERROR_CODES,
  createFailure,
  formatAlert,
  renderAlertText,
} from '../../src/failure-model/index.js';
import { GOLDEN_ALERTS } from './fixtures/golden-alerts.js';
import { ALL_CODES, GOLDEN_OPTS, sampleFailureFor } from './fixtures/sample-errors.js';

const CONTRACT_FIELDS = [
  'errorCode',
  'severity',
  'whatBroke',
  'likelyRootCause',
  'impact',
  'immediateRemediation',
  'longerTermFix',
  'dataSafe',
  'callsState',
  'runbookRef',
  'timestamp',
  'environment',
  'affectedScope',
] as const;

describe('formatAlert', () => {
  it('every code matches its golden alert and carries all contract fields', () => {
    for (const code of ALL_CODES) {
      const formatted = formatAlert(sampleFailureFor(code), GOLDEN_OPTS);
      for (const field of CONTRACT_FIELDS) {
        expect(formatted[field], `${code}.${field}`).toBeDefined();
      }
      expect(formatted).toEqual(GOLDEN_ALERTS[code]);
    }
  });

  it('golden set covers exactly the error codes', () => {
    expect(Object.keys(GOLDEN_ALERTS).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('renders whatBroke and likelyRootCause as plain language, keeping the code in the header', () => {
    // Regression: the DEAD_LETTER_CREATED alert used to read "What broke: DEAD_LETTER_CREATED /
    // Likely root cause: DEAD_LETTER_CREATED" — the code three times, meaningless to a
    // non-technical reader. The code stays ONLY in the header line for correlation.
    const err = sampleFailureFor('DEAD_LETTER_CREATED');
    const text = renderAlertText(err, GOLDEN_OPTS);
    const [header, whatBroke, likelyRootCause] = text.split('\n');

    expect(header).toContain('DEAD_LETTER_CREATED');
    expect(whatBroke).toMatch(/^What broke: /);
    expect(whatBroke).not.toContain('DEAD_LETTER_CREATED');
    expect(likelyRootCause).toMatch(/^Likely root cause: /);
    expect(likelyRootCause).not.toContain('DEAD_LETTER_CREATED');
    // The two lines say different things — cause is not a restatement of the symptom.
    expect(whatBroke?.replace(/^What broke: /, '')).not.toBe(
      likelyRootCause?.replace(/^Likely root cause: /, ''),
    );
  });

  it('affectedScope lists key names in the fixed priority order, never values', () => {
    const err = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      context: { environment: 'staging', call_id: 'c-1' },
    });
    const formatted = formatAlert(err, GOLDEN_OPTS);
    // call_id before environment (priority order), and only key names.
    expect(formatted.affectedScope).toEqual(['call_id', 'environment']);
  });

  it('re-parses error and throws on catalog-inconsistent hand-built fields', () => {
    const base = createFailure('DIALPAD_RATE_LIMITED', { processingState: 'degraded' });
    const badCategory: FailureFields = {
      ...base,
      root_cause_category: 'MODEL_AUTH_FAILED',
      context: base.context,
    };
    const badImpact: FailureFields = { ...base, impact: 'wrong impact', context: base.context };
    expect(() => formatAlert(badCategory, GOLDEN_OPTS)).toThrow();
    expect(() => formatAlert(badImpact, GOLDEN_OPTS)).toThrow();
  });

  it('validates opts — invalid environment or timestamp throws', () => {
    const err = sampleFailureFor('DIALPAD_RATE_LIMITED');
    expect(() =>
      formatAlert(err, { environment: 'nope', timestamp: GOLDEN_OPTS.timestamp }),
    ).toThrow();
    expect(() => formatAlert(err, { environment: 'staging', timestamp: 'not-a-date' })).toThrow();
  });
});

describe('renderAlertText', () => {
  it('never renders context values through the public path (key names only)', () => {
    const secretCallId = 'SECRET-CALLID-XYZ';
    const err = createFailure('DIALPAD_RATE_LIMITED', {
      processingState: 'degraded',
      context: { call_id: secretCallId, environment: 'staging' },
    });
    const text = renderAlertText(err, GOLDEN_OPTS);
    expect(text).not.toContain(secretCallId);
    expect(text).toContain('Affected: call_id, environment');
  });

  it('validates opts too', () => {
    const err = sampleFailureFor('DIALPAD_RATE_LIMITED');
    expect(() =>
      renderAlertText(err, { environment: 'nope', timestamp: GOLDEN_OPTS.timestamp }),
    ).toThrow();
    expect(() =>
      renderAlertText(err, { environment: 'staging', timestamp: 'not-a-date' }),
    ).toThrow();
  });
});
