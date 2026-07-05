/**
 * Key-lifecycle failures carry a failure-model code (Task 8.2) so the CLI/alerting layer can emit
 * the right §4 alert. The message is always sanitized — never key bytes, transcript content, or PII.
 */
export type KeyLifecycleCode = 'KEY_ROTATION_FAILED' | 'KEY_REVOCATION_FAILED';

export class KeyLifecycleError extends Error {
  readonly code: KeyLifecycleCode;
  constructor(code: KeyLifecycleCode, message: string) {
    super(message);
    this.name = 'KeyLifecycleError';
    this.code = code;
  }
}
