import { createHmac } from 'node:crypto';

/**
 * One-way keyed hash for any phone/name found in a webhook payload, so the (purgeable) audit row
 * never stores raw PII. HMAC-SHA256 hex under a dedicated secret passed in by the caller — never
 * read ambiently, so there is no code path that stores plaintext when the secret is absent.
 */
export function hashPii(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value.trim()).digest('hex');
}
