import { describe, expect, it } from 'vitest';
import { hashPii } from '../../src/dialpad/webhook/hash.js';
import {
  collectPii,
  describePayloadShape,
  extractCallId,
  normalizePhone,
  parseClaims,
  replayKeyFor,
  resolveCallId,
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
    // Names are normalized (trim + collapse whitespace + lowercase) before hashing (issue #35).
    expect(payload.name_hmac).toEqual([hashOne('jane doe')]);

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

describe('resolveCallId (alias + nesting tolerance, issue #31)', () => {
  it('reads the confirmed top-level call_id (number or string)', () => {
    expect(resolveCallId({ call_id: 987654321 })).toBe('987654321');
    expect(resolveCallId({ call_id: 'abc-1' })).toBe('abc-1');
  });

  it('accepts camelCase and call/data wrapper shapes for the same information', () => {
    expect(resolveCallId({ callId: '42' })).toBe('42');
    expect(resolveCallId({ call: { id: 4917123 } })).toBe('4917123');
    expect(resolveCallId({ call: { call_id: '77' } })).toBe('77');
    expect(resolveCallId({ data: { call_id: 88 } })).toBe('88');
    expect(resolveCallId({ data: { id: 'd-9' } })).toBe('d-9');
  });

  it('prefers the explicit top-level call_id over nested variants', () => {
    expect(resolveCallId({ call_id: '1', call: { id: '2' } })).toBe('1');
  });

  it('returns undefined when no known call-id field is present (clean reject, not a crash)', () => {
    expect(resolveCallId({ event_id: 'evt-x', state: 'connected' })).toBeUndefined();
    expect(resolveCallId({ call_id: '   ' })).toBeUndefined();
    expect(resolveCallId({})).toBeUndefined();
  });

  it('does not treat a bare top-level id (the event id) as the call id', () => {
    expect(resolveCallId({ id: 'evt-9' })).toBeUndefined();
  });
});

describe('toCallStateMetadata (alias + nesting tolerance)', () => {
  it('resolves the internal alias and metadata nested under a call wrapper', () => {
    const meta = toCallStateMetadata({
      call: { direction: 'inbound', state: 'connected', duration: 12 },
      internal: true,
    });
    expect(meta).toEqual({
      direction: 'inbound',
      state: 'connected',
      duration: 12,
      is_internal: true,
    });
  });
});

describe('PII normalization + over-broad tightening (issue #35)', () => {
  const audit = (claims: Record<string, unknown>): Record<string, unknown> =>
    toAuditPayload(resultFor(claims), hashOne);

  it('hashes a phone stably across punctuation and spacing', () => {
    const a = audit({ call_id: '1', phone: '+1 (555) 123-4567' });
    const b = audit({ call_id: '1', phone: '+15551234567' });
    expect(a.phone_hmac).toEqual(b.phone_hmac);
    expect(a.phone_hmac).toEqual([hashOne('+15551234567')]);
  });

  it('hashes a name stably across case and internal spacing', () => {
    const a = audit({ call_id: '1', contact_name: 'Jane  DOE' });
    const b = audit({ call_id: '1', contact_name: 'jane doe' });
    expect(a.name_hmac).toEqual(b.name_hmac);
  });

  it('drops non-phone labels collected under a phone object (over-broad tightening)', () => {
    const payload = audit({
      call_id: '1',
      contact: { phone: { primary: '+15550001111', label: 'work' } },
    });
    // Only the real number survives; the "work" label is not hashed as a phone.
    expect(payload.phone_hmac).toEqual([hashOne(normalizePhone('+15550001111') as string)]);
  });

  it('drops short numeric noise below a plausible phone length', () => {
    expect(audit({ call_id: '1', number: 42 })).not.toHaveProperty('phone_hmac');
  });

  it('hashes an email, normalized to lowercase, deduped across fields', () => {
    const a = audit({ call_id: '1', email: 'Jane.Doe@Example.COM' });
    const b = audit({ call_id: '1', contact_email: 'jane.doe@example.com' });
    expect(a.email_hmac).toEqual(b.email_hmac);
    expect(a.email_hmac).toEqual([hashOne('jane.doe@example.com')]);
  });

  it('dedupes the same phone supplied in two formats to one hmac', () => {
    const payload = audit({
      call_id: '1',
      from_number: '(555) 123-4567',
      to_number: '555-123-4567',
    });
    expect(payload.phone_hmac).toEqual([hashOne('5551234567')]);
  });
});

describe('describePayloadShape (issue #31 diagnostic — field names + types, never values)', () => {
  it('emits path:type entries for scalars, never the values', () => {
    const shape = describePayloadShape({ call_id: 555, direction: 'inbound', is_internal: false });
    expect(shape.sort()).toEqual(
      ['call_id:number', 'direction:string', 'is_internal:boolean'].sort(),
    );
  });

  it('describes nested objects by dotted path', () => {
    const shape = describePayloadShape({ call: { id: 4917123, state: 'connected' } });
    expect(shape.sort()).toEqual(['call.id:number', 'call.state:string'].sort());
  });

  it('describes array element shapes under a []-suffixed path, deduped', () => {
    const shape = describePayloadShape({
      participants: [{ role: 'operator' }, { role: 'customer' }],
    });
    expect(shape).toEqual(['participants[].role:string']);
  });

  it('never leaks a value — a phone/name/transcript appears only as its key path and type', () => {
    const shape = describePayloadShape({
      contact: { name: 'Jane Doe', phone: '+15551234567' },
      transcript: 'the caller said secret words',
    });
    const joined = shape.join('\n');
    expect(shape.sort()).toEqual(
      ['contact.name:string', 'contact.phone:string', 'transcript:string'].sort(),
    );
    for (const value of ['Jane Doe', '+15551234567', 'secret words']) {
      expect(joined).not.toContain(value);
    }
  });

  it('marks null and empty arrays without throwing', () => {
    const shape = describePayloadShape({ ended: null, tags: [] });
    expect(shape.sort()).toEqual(['ended:null', 'tags:array(empty)'].sort());
  });
});
