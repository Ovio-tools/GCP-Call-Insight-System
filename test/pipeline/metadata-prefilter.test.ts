import { describe, expect, it } from 'vitest';
import { evaluateMetadata } from '../../src/pipeline/metadata-prefilter.js';

const CALL = 'call-A';

describe('evaluateMetadata', () => {
  it('drops a zero-duration call', () => {
    expect(evaluateMetadata(CALL, { duration: 0 })).toEqual({
      action: 'drop',
      reason: 'zero_duration',
    });
  });

  it('drops a clear non-conversation call state', () => {
    expect(evaluateMetadata(CALL, { state: 'no_answer', duration: 5 })).toEqual({
      action: 'drop',
      reason: 'non_conversation_call_state',
    });
  });

  it('does NOT drop voicemail (fails open)', () => {
    expect(evaluateMetadata(CALL, { state: 'voicemail', duration: 5 })).toEqual({
      action: 'pass',
    });
  });

  it('drops an explicit outbound internal-only leg', () => {
    expect(
      evaluateMetadata(CALL, { direction: 'outbound', is_internal: true, duration: 30 }),
    ).toEqual({ action: 'drop', reason: 'outbound_no_customer_conversation' });
  });

  it('drops a flagged internal non-operator transfer leg', () => {
    // This leg (call-A) is flagged internal and the operator leg is a DIFFERENT call.
    expect(
      evaluateMetadata(CALL, {
        is_internal: true,
        operator_call_id: 'call-OP',
        master_call_id: 'call-M',
        duration: 12,
      }),
    ).toEqual({ action: 'drop', reason: 'internal_transfer_non_operator_leg' });
  });

  it('passes the true operator/customer leg of a transfer graph', () => {
    // operator_call_id === this call id → this IS the operator leg.
    expect(
      evaluateMetadata('call-OP', {
        operator_call_id: 'call-OP',
        master_call_id: 'call-M',
        duration: 40,
      }),
    ).toEqual({ action: 'pass' });
  });

  it('passes on id inequality alone without an is_internal marker', () => {
    expect(
      evaluateMetadata(CALL, {
        operator_call_id: 'call-OP',
        master_call_id: 'call-M',
        duration: 12,
      }),
    ).toEqual({ action: 'pass' });
  });

  it('passes an ambiguous outbound call with no internal marker', () => {
    expect(evaluateMetadata(CALL, { direction: 'outbound', duration: 30 })).toEqual({
      action: 'pass',
    });
  });

  it('passes an incomplete transfer graph (master but no operator id)', () => {
    expect(evaluateMetadata(CALL, { master_call_id: 'call-M', duration: 12 })).toEqual({
      action: 'pass',
    });
  });

  it('passes when duration is absent', () => {
    expect(evaluateMetadata(CALL, { direction: 'inbound' })).toEqual({ action: 'pass' });
  });

  it('passes on unparseable / non-object metadata (fail open)', () => {
    expect(evaluateMetadata(CALL, 'not-an-object')).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, null)).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, [1, 2, 3])).toEqual({ action: 'pass' });
  });

  it('drops a negative-duration call as zero_duration', () => {
    expect(evaluateMetadata(CALL, { duration: -10 })).toEqual({
      action: 'drop',
      reason: 'zero_duration',
    });
  });

  it('passes when duration is a string, not a number (fail open)', () => {
    expect(evaluateMetadata(CALL, { duration: '0' })).toEqual({ action: 'pass' });
  });

  it('passes when duration is NaN (NaN <= 0 is false)', () => {
    expect(evaluateMetadata(CALL, { duration: NaN })).toEqual({ action: 'pass' });
  });

  it('matches call state case-insensitively', () => {
    expect(evaluateMetadata(CALL, { state: 'MISSED', duration: 5 })).toEqual({
      action: 'drop',
      reason: 'non_conversation_call_state',
    });
  });

  it('passes when is_internal is truthy but not strictly true (fail open)', () => {
    // is_internal: 1 is not a boolean → schema parse fails → fail open → pass.
    expect(evaluateMetadata(CALL, { is_internal: 1, direction: 'outbound', duration: 5 })).toEqual({
      action: 'pass',
    });
  });
});

describe('evaluateMetadata minimum-duration rule', () => {
  const MIN = { minDurationMs: 1000 };

  it('drops a call shorter than the minimum as below_minimum_duration', () => {
    expect(evaluateMetadata(CALL, { duration: 400, state: 'hangup' }, MIN)).toEqual({
      action: 'drop',
      reason: 'below_minimum_duration',
    });
  });

  it('drops a call exactly AT the minimum (the bound is inclusive)', () => {
    expect(evaluateMetadata(CALL, { duration: 1000, state: 'hangup' }, MIN)).toEqual({
      action: 'drop',
      reason: 'below_minimum_duration',
    });
  });

  it('passes a call one millisecond above the minimum', () => {
    expect(evaluateMetadata(CALL, { duration: 1001, state: 'hangup' }, MIN)).toEqual({
      action: 'pass',
    });
  });

  it('is DISABLED by default, so existing two-argument callers are unaffected', () => {
    expect(evaluateMetadata(CALL, { duration: 400, state: 'hangup' })).toEqual({ action: 'pass' });
  });

  it('is disabled by an explicit zero threshold', () => {
    expect(evaluateMetadata(CALL, { duration: 400, state: 'hangup' }, { minDurationMs: 0 })).toEqual(
      { action: 'pass' },
    );
  });

  it('keeps zero_duration for a call that never connected (the more specific reason wins)', () => {
    expect(evaluateMetadata(CALL, { duration: 0 }, MIN)).toEqual({
      action: 'drop',
      reason: 'zero_duration',
    });
    expect(evaluateMetadata(CALL, { duration: -5 }, MIN)).toEqual({
      action: 'drop',
      reason: 'zero_duration',
    });
  });

  it('keeps an explicit non-conversation call state over the duration policy', () => {
    // 'no_answer' tells the operator WHY far better than "too short" does.
    expect(evaluateMetadata(CALL, { duration: 400, state: 'no_answer' }, MIN)).toEqual({
      action: 'drop',
      reason: 'non_conversation_call_state',
    });
  });

  it('still fails open on an absent, non-numeric, or NaN duration', () => {
    expect(evaluateMetadata(CALL, { state: 'hangup' }, MIN)).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, { duration: '400' }, MIN)).toEqual({ action: 'pass' });
    expect(evaluateMetadata(CALL, { duration: NaN }, MIN)).toEqual({ action: 'pass' });
  });

  it('drops a long internal outbound leg by its own rule, not by duration', () => {
    expect(
      evaluateMetadata(CALL, { duration: 30_000, direction: 'outbound', is_internal: true }, MIN),
    ).toEqual({ action: 'drop', reason: 'outbound_no_customer_conversation' });
  });
});
