import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ACTIONS,
  APPROVE_FORWARD_STAGE,
  ORIGIN_STAGES,
  REPROCESS_STAGES,
  REVIEW_ACTIONS,
  isActionAllowed,
} from '../../src/review/action-matrix.js';
import { HELD_REASON } from '../../src/db/enums.js';

describe('review action matrix (Task 6.2)', () => {
  it('is total over every held_reason', () => {
    for (const reason of HELD_REASON) {
      expect(ALLOWED_ACTIONS[reason], `ALLOWED_ACTIONS[${reason}]`).toBeInstanceOf(Set);
      expect(REPROCESS_STAGES[reason], `REPROCESS_STAGES[${reason}]`).toBeDefined();
      expect(ORIGIN_STAGES[reason], `ORIGIN_STAGES[${reason}]`).toBeDefined();
    }
  });

  it('every reason allows reject and mark_unresolvable', () => {
    for (const reason of HELD_REASON) {
      expect(ALLOWED_ACTIONS[reason].has('reject')).toBe(true);
      expect(ALLOWED_ACTIONS[reason].has('mark_unresolvable')).toBe(true);
    }
  });

  it('allows reprocess exactly when the reason has reprocess stages', () => {
    for (const reason of HELD_REASON) {
      expect(ALLOWED_ACTIONS[reason].has('reprocess')).toBe(REPROCESS_STAGES[reason].length > 0);
    }
  });

  it('offers approve only for classifier_uncertain and emergency_review, matching APPROVE_FORWARD_STAGE', () => {
    expect(APPROVE_FORWARD_STAGE.classifier_uncertain).toBe('extract');
    expect(APPROVE_FORWARD_STAGE.emergency_review).toBe('verbatim-pii-scan');
    for (const reason of HELD_REASON) {
      const offersApprove = ALLOWED_ACTIONS[reason].has('approve');
      expect(offersApprove).toBe(APPROVE_FORWARD_STAGE[reason] !== undefined);
    }
  });

  it('scopes correct_extraction to schema_invalid only', () => {
    for (const reason of HELD_REASON) {
      expect(ALLOWED_ACTIONS[reason].has('correct_extraction')).toBe(reason === 'schema_invalid');
    }
  });

  it('classified_spam allows mark_spam; missing_transcript and weak_servicetitan_match do not', () => {
    expect(ALLOWED_ACTIONS.classified_spam.has('mark_spam')).toBe(true);
    expect(ALLOWED_ACTIONS.missing_transcript.has('mark_spam')).toBe(false);
    expect(ALLOWED_ACTIONS.weak_servicetitan_match.has('mark_spam')).toBe(false);
  });

  it('weak_servicetitan_match offers no approve/mark_non_customer/reprocess', () => {
    const s = ALLOWED_ACTIONS.weak_servicetitan_match;
    expect(s.has('approve')).toBe(false);
    expect(s.has('mark_non_customer')).toBe(false);
    expect(s.has('reprocess')).toBe(false);
    expect([...s].sort()).toEqual(['mark_unresolvable', 'reject']);
  });

  it('residual_pii_detected always restarts at redact regardless of origin', () => {
    expect(REPROCESS_STAGES.residual_pii_detected).toEqual(['redact']);
    // But its origin set spans the three stages that can raise it.
    expect(ORIGIN_STAGES.residual_pii_detected).toEqual(['redact', 'extract', 'verbatim-pii-scan']);
  });

  it('every reprocess/approve target stage is a real pipeline stage', () => {
    const known = new Set([
      'metadata-pre-filter',
      'fetch-transcript',
      'transcript-availability',
      'redact',
      'classify',
      'extract',
      'verbatim-pii-scan',
      'store',
      'mark-retention-eligible',
    ]);
    for (const reason of HELD_REASON) {
      for (const stage of REPROCESS_STAGES[reason]) expect(known.has(stage)).toBe(true);
      const fwd = APPROVE_FORWARD_STAGE[reason];
      if (fwd) expect(known.has(fwd)).toBe(true);
    }
  });

  it('isActionAllowed reflects the sets', () => {
    expect(isActionAllowed('schema_invalid', 'correct_extraction')).toBe(true);
    expect(isActionAllowed('classified_spam', 'correct_extraction')).toBe(false);
    expect(REVIEW_ACTIONS).toContain('reprocess');
  });
});
