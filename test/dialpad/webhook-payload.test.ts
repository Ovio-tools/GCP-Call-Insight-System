import { describe, expect, it } from 'vitest';
import { hashPii } from '../../src/dialpad/webhook/hash.js';
import {
  collectPii,
  extractCallId,
  parseClaims,
  replayKeyFor,
  toAuditPayload,
  toCallStateMetadata,
} from '../../src/dialpad/webhook/payload.js';
import type { DialpadJwtResult } from '../../src/dialpad/webhook/jwt.js';

const HASH_SECRET = 'pii-hash-secret-0123456789abcdef';
const hashOne = (v: string): string => hashPii(v, HASH_SECRET);

function resultFor(claims: Record<string, unknown>): DialpadJwtResult {
  const payloadSegment = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { claims, secretSlot: 'primary', payloadSegment };
}

describe('hashPii', () => {
  it('is deterministic, not equal to input, and secret-dependent', () => {
    expect(hashPii('+15551234567', HASH_SECRET)).toBe(hashPii('+15551234567', HASH_SECRET));
    expect(hashPii('+15551234567', HASH_SECRET)).not.toBe('+15551234567');
    expect(hashPii('+15551234567', HASH_SECRET)).not.toBe(hashPii('+15551234567', 'other-secret'));
  });
});

describe('collectPii', () => {
  it('finds phone/name values anywhere, including nested objects', () => {
    const { phones, names } = collectPii({
      external_number: '+15551112222',
      contact: { name: 'Jane Doe', phone: '+15553334444' },
      nested: [{ display_name: 'Ops Bot' }],
      state: 'connected',
    });
    expect(phones.sort()).toEqual(['+15551112222', '+15553334444']);
    expect(names.sort()).toEqual(['Jane Doe', 'Ops Bot']);
  });

  it('finds phone/name values wrapped in arrays or objects under a PII key', () => {
    const { phones, names } = collectPii({
      phone: ['+15551234567', '+15559876543'],
      name: ['Jane Doe'],
      contact: { phone: { primary: '+15550001111', label: 'work' } },
    });
    expect(phones.sort()).toEqual(['+15550001111', '+15551234567', '+15559876543', 'work']);
    expect(names).toEqual(['Jane Doe']);
  });
});

describe('parseClaims (lenient per-field)', () => {
  it('drops a wrong-typed optional field without losing the others', () => {
    const claims = parseClaims({
      call_id: '555',
      duration: 'not-a-number', // wrong type
      is_internal: 'nope', // wrong type
      direction: 'inbound',
    });
    expect(claims.call_id).toBe('555');
    expect(claims.direction).toBe('inbound');
    expect(claims.duration).toBeUndefined();
    expect(claims.is_internal).toBeUndefined();
  });
});

describe('toCallStateMetadata', () => {
  it('keeps only non-PII metadata and drops PII and free text', () => {
    const meta = toCallStateMetadata({
      call_id: '123',
      direction: 'inbound',
      state: 'connected',
      duration: 42,
      is_internal: false,
      operator_call_id: 999,
      master_call_id: 1000,
      // PII / content that must NOT survive:
      contact_name: 'Jane Doe',
      external_number: '+15551234567',
      transcript: 'secret words',
      note: 'free text',
    });
    expect(meta).toEqual({
      direction: 'inbound',
      state: 'connected',
      duration: 42,
      is_internal: false,
      operator_call_id: '999',
      master_call_id: '1000',
    });
    const serialized = JSON.stringify(meta);
    for (const leak of ['Jane Doe', '+15551234567', 'secret words', 'free text', 'hmac']) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('toAuditPayload', () => {
  it('keeps the allowlist, hashes phone/name, and never stores raw PII or free text', () => {
    const result = resultFor({
      event_id: 'evt-77',
      call_id: 555,
      direction: 'inbound',
      state: 'connected',
      iat: 1_700_000_000,
      contact: { name: 'Jane Doe', phone: '+15551234567' },
      transcript: 'the caller said secret words',
      voicemail_note: 'free text note',
    });
    const payload = toAuditPayload(result, hashOne);

    expect(payload.event_id).toBe('id:evt-77');
    expect(payload.call_id).toBe('555');
    expect(payload.direction).toBe('inbound');
    expect(payload.state).toBe('connected');
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.phone_hmac).toEqual([hashOne('+15551234567')]);
    expect(payload.name_hmac).toEqual([hashOne('Jane Doe')]);

    const serialized = JSON.stringify(payload);
    for (const leak of [
      'Jane Doe',
      '+15551234567',
      'secret words',
      'free text note',
      'transcript',
      'voicemail_note',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('omits hmac keys when no phone/name is present', () => {
    const payload = toAuditPayload(
      resultFor({ event_id: 'e', call_id: '1', state: 'connected' }),
      hashOne,
    );
    expect(payload).not.toHaveProperty('phone_hmac');
    expect(payload).not.toHaveProperty('name_hmac');
  });
});

describe('replayKeyFor (fallback matrix)', () => {
  it('(a) prefers a unique event id claim', () => {
    expect(replayKeyFor(resultFor({ jti: 'j1', event_id: 'e1', iat: 1 }))).toBe('id:j1');
    expect(replayKeyFor(resultFor({ event_id: 'e1', iat: 1 }))).toBe('id:e1');
    expect(replayKeyFor(resultFor({ id: 'i1' }))).toBe('id:i1');
  });

  it('(b) falls back to signed-payload digest + iat when no event id', () => {
    const key = replayKeyFor(resultFor({ call_id: 'c', state: 'connected', iat: 1_700_000_000 }));
    expect(key).toMatch(/^sig:[0-9a-f]{64}:1700000000$/);
  });

  it('(c) falls back to digest alone when neither id nor timestamp exists', () => {
    const key = replayKeyFor(resultFor({ call_id: 'c', state: 'connected' }));
    expect(key).toMatch(/^sig:[0-9a-f]{64}$/);
  });

  it('distinguishes two distinct events but collapses byte-identical ones (documented limitation)', () => {
    const a = resultFor({ call_id: 'c', state: 'connected', iat: 1 });
    const b = resultFor({ call_id: 'c', state: 'missed', iat: 1 });
    expect(replayKeyFor(a)).not.toBe(replayKeyFor(b)); // distinct payloads → distinct keys
    // Branch (c): byte-identical payloads collapse to the same key.
    const seg = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
    const same1: DialpadJwtResult = {
      claims: { x: 1 },
      secretSlot: 'primary',
      payloadSegment: seg,
    };
    const same2: DialpadJwtResult = {
      claims: { x: 1 },
      secretSlot: 'primary',
      payloadSegment: seg,
    };
    expect(replayKeyFor(same1)).toBe(replayKeyFor(same2));
  });
});

describe('extractCallId / parseClaims', () => {
  it('coerces numeric ids to strings and rejects empties', () => {
    expect(extractCallId(parseClaims({ call_id: 987654321 }))).toBe('987654321');
    expect(extractCallId(parseClaims({ call_id: '  ' }))).toBeUndefined();
    expect(extractCallId(parseClaims({}))).toBeUndefined();
  });
});
