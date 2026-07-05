import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dialpad webhook JWT verification (Task 3.2).
 *
 * When a secret is configured on the event subscription, Dialpad sends each event as a compact
 * JWS — the ENTIRE HTTP body is the token — signed with the shared secret using HS256. We verify
 * the signature (with the `alg` pinned to HS256, blocking `alg:none` and algorithm-confusion),
 * then the JSON event data is the JWT payload. Pure, no I/O.
 */

/** The signing secrets: the active one, plus an optional previous one accepted during rotation. */
export interface DialpadSecrets {
  primary: string;
  previous?: string;
}

export interface DialpadJwtResult {
  /** Decoded JWT payload (the event data). Validated downstream by the payload schema. */
  claims: Record<string, unknown>;
  /** Which secret matched — logged (as a non-secret field) so rotation can be observed. */
  secretSlot: 'primary' | 'previous';
  /** The exact base64url payload segment (the signed bytes) — a canonical basis for a replay
   * digest when the payload carries no unique event id. */
  payloadSegment: string;
}

/** Decode a base64url segment to a UTF-8 JSON object, or null if it is not valid JSON. */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Constant-time compare of two HMAC digests (equal length required; length mismatch → false). */
function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify the HS256 signature over the JWT signing input for the primary then (if configured) the
 * previous secret, and return the decoded claims plus which slot matched. Returns null on any
 * failure — wrong/missing signature, non-HS256 alg, or an unparseable structure — so the caller
 * maps it to WEBHOOK_SIGNATURE_INVALID without leaking why.
 */
export function verifyAndDecodeDialpadJwt(
  rawBody: Buffer,
  secrets: DialpadSecrets,
): DialpadJwtResult | null {
  const token = rawBody.toString('utf8').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  if (!headerSeg || !payloadSeg || !signatureSeg) return null;

  // Pin the algorithm: only HS256 is accepted. Blocks `alg:none` and RS/ES confusion.
  const header = decodeJsonSegment(headerSeg);
  if (!header || header.alg !== 'HS256') return null;

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(signatureSeg, 'base64url');
  } catch {
    return null;
  }
  if (providedSig.length === 0) return null;

  const signingInput = `${headerSeg}.${payloadSeg}`;
  const candidates: { slot: 'primary' | 'previous'; secret: string }[] = [
    { slot: 'primary', secret: secrets.primary },
  ];
  if (secrets.previous) {
    candidates.push({ slot: 'previous', secret: secrets.previous });
  }

  for (const { slot, secret } of candidates) {
    const expected = createHmac('sha256', secret).update(signingInput).digest();
    if (digestsEqual(expected, providedSig)) {
      const claims = decodeJsonSegment(payloadSeg);
      if (!claims) return null;
      return { claims, secretSlot: slot, payloadSegment: payloadSeg };
    }
  }
  return null;
}
