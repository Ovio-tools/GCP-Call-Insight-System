/**
 * Redaction guard.
 *
 * Convention (build plan §3): no transcript content or PII in any log line, EVER.
 * Rather than silently masking, this guard REFUSES to log known content/PII fields
 * — it throws — so leaks fail loudly in dev and test instead of shipping to prod.
 *
 * The pino logger also configures these as `redact` paths as defense-in-depth (see
 * logger.ts); the guard is the primary, fail-loud line of defence.
 */

/** Field names that must never appear in a log line. Compared case-insensitively. */
export const CONTENT_FIELDS: readonly string[] = [
  // Transcript / call content
  'transcript',
  'transcript_text',
  'transcriptText',
  'content',
  'text',
  'body',
  'message',
  'audio',
  'recording',
  'recording_url',
  'recordingUrl',
  // Direct PII
  'pii',
  'name',
  'customer_name',
  'customer_email',
  'customer_phone',
  'email',
  'phone',
  'address',
  'ssn',
  // Secrets / key material
  'token',
  'secret',
  'password',
  'api_key',
  'apiKey',
  'dek',
  'kek',
];

const CONTENT_FIELD_SET: ReadonlySet<string> = new Set(CONTENT_FIELDS.map((f) => f.toLowerCase()));

/** True if `key` is a known content/PII field that must not be logged. */
export function isContentField(key: string): boolean {
  return CONTENT_FIELD_SET.has(key.toLowerCase());
}

/** Raised when a log call is asked to emit a known content/PII field. */
export class RedactionError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Refusing to log known content field: "${field}"`);
    this.name = 'RedactionError';
    this.field = field;
  }
}

/**
 * Throw {@link RedactionError} if `value` contains a known content field, scanning
 * recursively. Returns nothing on success. Used by the logger's hook on every call.
 */
export function assertNoContentFields(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoContentFields(item, seen);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isContentField(key)) {
      throw new RedactionError(key);
    }
    assertNoContentFields(nested, seen);
  }
}
