import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Signature-verification building blocks. The shared middleware does not know any provider's
 * scheme — each webhook (Task 3.2 Dialpad, Task 12.1 ServiceTitan) supplies a
 * {@link SignatureVerifier} built from these helpers, always over the RAW request body.
 */

/** Verify a request's authenticity from its raw bytes and headers. Return true if valid. */
export type SignatureVerifier = (
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
) => boolean | Promise<boolean>;

/** Lower-case hex HMAC-SHA256 of `rawBody` under `secret`. */
export function hmacSha256Hex(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time compare of two signatures given as hex strings. Length-mismatched or
 * malformed inputs return false without leaking timing. Never use `===` on signatures.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
