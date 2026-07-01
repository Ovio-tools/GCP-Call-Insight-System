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
});
