import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAndDecodeDialpadJwt } from '../../src/dialpad/webhook/jwt.js';

const PRIMARY = 'dialpad-primary-secret-0123456789';
const PREVIOUS = 'dialpad-previous-secret-abcdef0000';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build a compact JWS the way Dialpad does (whole body = token). */
function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  { alg = 'HS256' }: { alg?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const sig =
    alg === 'none' ? '' : createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

describe('verifyAndDecodeDialpadJwt', () => {
  const claims = { call_id: 'c1', event_id: 'e1', iat: 1_700_000_000 };

  it('accepts a valid HS256 token signed with the primary secret', () => {
    const token = signJwt(claims, PRIMARY);
    const result = verifyAndDecodeDialpadJwt(Buffer.from(token), { primary: PRIMARY });
    expect(result).not.toBeNull();
    expect(result?.secretSlot).toBe('primary');
    expect(result?.claims).toMatchObject({ call_id: 'c1', event_id: 'e1' });
    expect(result?.payloadSegment).toBe(token.split('.')[1]);
  });

  it('accepts a token signed with the previous secret during rotation overlap', () => {
    const token = signJwt(claims, PREVIOUS);
    const result = verifyAndDecodeDialpadJwt(Buffer.from(token), {
      primary: PRIMARY,
      previous: PREVIOUS,
    });
    expect(result?.secretSlot).toBe('previous');
  });

  it('rejects a token whose previous secret is not configured', () => {
    const token = signJwt(claims, PREVIOUS);
    expect(verifyAndDecodeDialpadJwt(Buffer.from(token), { primary: PRIMARY })).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signJwt(claims, PRIMARY);
    const [h, , s] = token.split('.');
    const tamperedPayload = b64url(JSON.stringify({ ...claims, call_id: 'attacker' }));
    const tampered = `${h}.${tamperedPayload}.${s}`;
    expect(verifyAndDecodeDialpadJwt(Buffer.from(tampered), { primary: PRIMARY })).toBeNull();
  });

  it('rejects alg:none (blocks unsigned tokens)', () => {
    const token = signJwt(claims, PRIMARY, { alg: 'none' });
    expect(verifyAndDecodeDialpadJwt(Buffer.from(token), { primary: PRIMARY })).toBeNull();
  });

  it('rejects a non-HS256 alg even when HMAC-signed (algorithm confusion)', () => {
    const token = signJwt(claims, PRIMARY, { alg: 'RS256' });
    expect(verifyAndDecodeDialpadJwt(Buffer.from(token), { primary: PRIMARY })).toBeNull();
  });

  it('rejects garbage and non-three-part bodies', () => {
    for (const junk of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', 'eyJ.eyJ.']) {
      expect(verifyAndDecodeDialpadJwt(Buffer.from(junk), { primary: PRIMARY })).toBeNull();
    }
  });
});
