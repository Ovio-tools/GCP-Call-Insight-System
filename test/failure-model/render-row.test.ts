import { describe, expect, it } from 'vitest';
import type { AlertEventRow } from '../../src/db/schemas/alert-events.js';
import type { JsonValue } from '../../src/db/types.js';
import {
  createFailure,
  failureSnapshot,
  renderAlertEventText,
} from '../../src/failure-model/index.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function makeRow(overrides: Partial<AlertEventRow> = {}): AlertEventRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    error_code: 'DATABASE_UNAVAILABLE',
    root_cause_category: 'DATABASE_UNAVAILABLE',
    severity: 'critical',
    dedup_key: 'db:global',
    acknowledged_at: null,
    created_at: NOW,
    failure_snapshot: {},
    delivery_state: 'pending',
    delivery_attempts: 0,
    next_attempt_at: NOW,
    delivered_at: null,
    last_delivery_error: null,
    ...overrides,
  };
}

/** The full sanitized failure fields `emitAlert` persists into `failure_snapshot`. */
function fullSnapshot(context: Record<string, string> = {}): Record<string, JsonValue> {
  const f = createFailure('DATABASE_UNAVAILABLE', { processingState: 'paused', context });
  return {
    error_code: f.error_code,
    root_cause_category: f.root_cause_category,
    severity: f.severity,
    impact: f.impact,
    processing_state: f.processing_state,
    remediation_now: f.remediation_now,
    remediation_fix: f.remediation_fix,
    data_safe: f.data_safe,
    calls_state: f.calls_state,
    owner: f.owner,
    runbook_ref: f.runbook_ref,
    context: f.context,
  };
}

describe('renderAlertEventText', () => {
  it('renders a full valid snapshot directly (path 1)', () => {
    const text = renderAlertEventText(
      makeRow({ failure_snapshot: fullSnapshot({ call_id: 'c-1' }) }),
      {
        environment: 'production',
        now: NOW,
      },
    );
    expect(text).toContain('DATABASE_UNAVAILABLE');
    expect(text).toContain('Postgres is unreachable');
    expect(text).toContain('production');
    expect(text).toContain(NOW.toISOString());
    expect(text).toContain('Affected: call_id');
  });

  it('reconstructs from error_code when the snapshot is empty (path 2, catalog fields)', () => {
    const text = renderAlertEventText(makeRow({ failure_snapshot: {} }), {
      environment: 'staging',
      now: NOW,
    });
    expect(text).toContain('[critical] DATABASE_UNAVAILABLE');
    expect(text).toContain('Likely root cause: The database is down');
    expect(text).toContain('Postgres is unreachable');
  });

  it('catalog root cause wins over a stale/wrong persisted root_cause_category', () => {
    const text = renderAlertEventText(
      makeRow({ failure_snapshot: { root_cause_category: 'REDIS_UNAVAILABLE' } }),
      { environment: 'production', now: NOW },
    );
    // Does not throw on the mismatch; renders the CATALOG root cause for the code.
    expect(text).toContain('Likely root cause: The database is down');
    expect(text).not.toContain('Redis');
  });

  it('keeps a valid persisted severity override, else falls back to the default', () => {
    const overridden = renderAlertEventText(makeRow({ severity: 'high' }), {
      environment: 'production',
      now: NOW,
    });
    expect(overridden).toContain('[high] DATABASE_UNAVAILABLE');
  });

  it('drops disallowed/content context keys before rendering (path 2)', () => {
    const text = renderAlertEventText(
      makeRow({ failure_snapshot: { context: { transcript: 'sensitive words', call_id: 'c-9' } } }),
      { environment: 'production', now: NOW },
    );
    expect(text).not.toContain('sensitive words');
    expect(text).not.toContain('transcript');
    expect(text).toContain('Affected: call_id');
  });

  it('renders/delivers a MODEL_COST_WARNING_THRESHOLD_EXCEEDED row with scope key names only, no context values (Task 7.2)', () => {
    // The emitter persists the full sanitized snapshot with context { stage, environment }.
    const failure = createFailure('MODEL_COST_WARNING_THRESHOLD_EXCEEDED', {
      processingState: 'continuing',
      context: { stage: 'classify', environment: 'staging' },
    });
    const text = renderAlertEventText(
      makeRow({
        error_code: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
        root_cause_category: 'MODEL_COST_WARNING_THRESHOLD_EXCEEDED',
        severity: 'medium',
        failure_snapshot: failureSnapshot(failure) as unknown as Record<string, JsonValue>,
      }),
      { environment: 'production', now: NOW },
    );
    // Renders the advisory (path 1) without throwing.
    expect(text).toContain('MODEL_COST_WARNING_THRESHOLD_EXCEEDED');
    expect(text).toContain('crossed the warning threshold');
    // Affected line lists the scope KEY NAMES in priority order, never their values.
    expect(text).toContain('Affected: stage, environment');
    // The stage VALUE ('classify') must never appear — only the key name does.
    expect(text).not.toContain('classify');
  });

  it('throws on an unknown error_code so the caller can mark delivery failed', () => {
    expect(() =>
      renderAlertEventText(makeRow({ error_code: 'NOT_A_REAL_CODE' }), {
        environment: 'production',
        now: NOW,
      }),
    ).toThrow();
  });
});
