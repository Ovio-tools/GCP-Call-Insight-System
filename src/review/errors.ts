/**
 * Domain errors for the review surface (Task 6.2), mapped to HTTP status by the routes (NOT the
 * failure model — a review-state conflict is not an operational failure that needs an alert).
 * Both carry only a terse, PII-free public message.
 */

/** A review-state conflict: a disallowed action, a stale/terminal review, a first-time-guard miss,
 * or a preflight miss. Rolls back the handler tx and maps to HTTP 409 — no audit/outbox/state
 * change. */
export class ReviewConflictError extends Error {
  readonly publicMessage: string;
  constructor(publicMessage = 'Action not permitted for this review state.') {
    super('review_action_conflict');
    this.name = 'ReviewConflictError';
    this.publicMessage = publicMessage;
  }
}

/** The review id does not exist. Maps to HTTP 404. */
export class ReviewNotFoundError extends Error {
  constructor() {
    super('review_not_found');
    this.name = 'ReviewNotFoundError';
  }
}
