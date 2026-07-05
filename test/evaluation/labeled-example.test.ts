import { describe, expect, it } from 'vitest';
import {
  actionToLabelSpec,
  buildClassifyLabel,
  buildExtractLabel,
  buildExtractRecord,
} from '../../src/evaluation/labeled-example.js';
import { HUMAN_REVIEW_PROBLEM_STATEMENT } from '../../src/review/correction-constants.js';
import { extractionRecordSchema } from '../../src/pipeline/extract/parse.js';

/**
 * Pure label builders (Task 6.3): map a resolved review action to a label spec, build the classify
 * bucket / full extract record, and run the extract schema gate — all with NO DB, NO PII.
 */
describe('actionToLabelSpec', () => {
  it('maps approve on classifier_uncertain to a customer classify label', () => {
    const spec = actionToLabelSpec('approve', 'classifier_uncertain', { action_params: {} });
    expect(spec).toEqual({ task_type: 'classify', bucket: 'customer' });
  });

  it('does NOT map approve on emergency_review (not a classify label)', () => {
    expect(actionToLabelSpec('approve', 'emergency_review', { action_params: {} })).toBeNull();
  });

  it('maps mark_non_customer and mark_spam to classify labels', () => {
    expect(actionToLabelSpec('mark_non_customer', 'classifier_uncertain', {})).toEqual({
      task_type: 'classify',
      bucket: 'non-customer',
    });
    expect(actionToLabelSpec('mark_spam', 'classified_spam', {})).toEqual({
      task_type: 'classify',
      bucket: 'spam',
    });
  });

  it('maps correct_extraction to an extract label with the four enums from action_params', () => {
    const spec = actionToLabelSpec('correct_extraction', 'schema_invalid', {
      action_params: {
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'urgent',
        sentiment: 'frustrated',
        target_stage: 'verbatim-pii-scan',
      },
    });
    expect(spec).toEqual({
      task_type: 'extract',
      enums: {
        call_intent: 'new_booking',
        service_category: 'water_heater',
        urgency: 'urgent',
        sentiment: 'frustrated',
      },
    });
  });

  it('returns null for a non-label action', () => {
    expect(actionToLabelSpec('reject', 'schema_invalid', {})).toBeNull();
    expect(actionToLabelSpec('reprocess', 'schema_invalid', {})).toBeNull();
    expect(actionToLabelSpec('mark_unresolvable', 'schema_invalid', {})).toBeNull();
  });
});

describe('buildClassifyLabel', () => {
  it('returns the expected-output bucket', () => {
    expect(buildClassifyLabel({ bucket: 'spam' })).toEqual({ bucket: 'spam' });
  });
});

describe('buildExtractRecord / buildExtractLabel', () => {
  const enums = {
    call_intent: 'new_booking',
    service_category: 'water_heater',
    urgency: 'urgent',
    sentiment: 'frustrated',
  };

  it('assembles a schema-valid 13-field record from the 4 enums + safe constants', () => {
    const record = buildExtractRecord(enums);
    expect(record.problem_statement).toBe(HUMAN_REVIEW_PROBLEM_STATEMENT);
    expect(record.customer_language).toEqual([]);
    expect(record.location_in_home).toBeNull();
    expect(extractionRecordSchema.safeParse(record).success).toBe(true);
  });

  it('buildExtractLabel accepts valid enums and surfaces schema failure on bad enums', () => {
    const ok = buildExtractLabel(enums);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.expected).toEqual(enums);
      expect(ok.record.call_intent).toBe('new_booking');
    }
    const bad = buildExtractLabel({ ...enums, urgency: 'not-a-real-urgency' });
    expect(bad.ok).toBe(false);
  });
});
