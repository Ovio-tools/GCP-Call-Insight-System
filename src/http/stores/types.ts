/**
 * The dependency-injection seams for the shared middleware's stateful pieces: an
 * injectable clock, a fixed-window rate counter, and a reserve/commit replay store.
 *
 * Production wires the Redis implementations (`./redis.js`); unit tests wire the in-memory
 * fakes (`./memory.js`) plus a controllable clock. Both back the same interfaces so the
 * middleware is identical in either mode.
 */

/** Wall-clock source. Injected so tests can advance time deterministically. */
export interface Clock {
  now(): number;
}

/** The real clock. */
export const systemClock: Clock = { now: () => Date.now() };

/** A fixed-window request counter keyed by an opaque string. */
export interface RateStore {
  /**
   * Increment the counter for `key`, starting a fresh `windowMs` window on the first hit.
   * Returns the running count within the current window (1 on the first request).
   */
  incr(key: string, windowMs: number): Promise<number>;
}

/** The outcome of a replay reservation. Only the acquirer receives commit/release. */
export interface Reservation {
  /** False when `key` is already reserved or committed within the window (a duplicate). */
  readonly acquired: boolean;
  /** Keep the entry for the full window — call after the handler succeeds. */
  commit(): Promise<void>;
  /** Drop the reservation so a legitimate retry is accepted — call after a handler failure. */
  release(): Promise<void>;
}

/**
 * Replay-protection store with reserve/commit semantics. Recording the entry up front (a
 * one-shot insert) would wrongly reject a provider's retry when the handler fails mid-way;
 * reserve/commit records permanently only once the handler has succeeded.
 */
export interface ReplayStore {
  reserve(key: string, windowMs: number): Promise<Reservation>;
}

/** A no-op reservation returned when the key was already seen (duplicate). */
export const NOT_ACQUIRED: Reservation = {
  acquired: false,
  async commit() {
    /* nothing reserved */
  },
  async release() {
    /* nothing reserved */
  },
};
