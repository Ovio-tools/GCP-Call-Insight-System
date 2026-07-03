import { createHmac } from 'node:crypto';

/**
 * Per-call value hash for redaction_findings.value_hash (Task 4.1):
 * HMAC-SHA256(key, call_id ‖ 0x00 ‖ normalized_value).
 *
 * Binding the call_id into the message is the anti-linkage property: the same
 * value in two different calls hashes differently, so findings rows cannot be
 * joined across calls even if leaked. Cross-call identity remains exclusively
 * the match_keys table's job (restricted role, its own HMAC keys).
 */
export function valueHash(key: Buffer, callId: string, normalizedValue: string): Buffer {
  return createHmac('sha256', key)
    .update(callId, 'utf8')
    .update(Buffer.from([0]))
    .update(normalizedValue, 'utf8')
    .digest();
}
