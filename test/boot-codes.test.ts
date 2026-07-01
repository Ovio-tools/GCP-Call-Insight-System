import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_UNAVAILABLE,
  FatalBootError,
  failBoot,
  sanitizeConnectionContext,
} from '../src/boot/codes.js';

/** A fake logger that records fatal + flush call order. */
function fakeLogger(order: string[]): Logger {
  return {
    fatal: vi.fn(() => order.push('fatal')),
    flush: vi.fn(() => order.push('flush')),
  } as unknown as Logger;
}

describe('sanitizeConnectionContext', () => {
  it('keeps host/port/database but NEVER the password', () => {
    const ctx = sanitizeConnectionContext('postgres://user:supersecret@db.internal:5432/appdb');
    expect(ctx).toEqual({ host: 'db.internal', port: '5432', database: 'appdb' });
    expect(JSON.stringify(ctx)).not.toContain('supersecret');
    expect(JSON.stringify(ctx)).not.toContain('user');
  });

  it('returns an empty object for an absent or unparseable URL', () => {
    expect(sanitizeConnectionContext(undefined)).toEqual({});
    expect(sanitizeConnectionContext('not a url')).toEqual({});
  });
});

describe('failBoot', () => {
  it('logs the fatal line, flushes, THEN exits non-zero — in that order', () => {
    const order: string[] = [];
    const logger = fakeLogger(order);
    const exit = vi.fn((_code: number) => {
      order.push('exit');
      return undefined as never;
    });

    const err = new FatalBootError(DATABASE_UNAVAILABLE, 'DATABASE_UNAVAILABLE: down', {
      host: 'db.internal',
    });
    failBoot(logger, err, { exit });

    expect(logger.fatal).toHaveBeenCalledWith(
      { error_code: DATABASE_UNAVAILABLE, context: { host: 'db.internal' } },
      'DATABASE_UNAVAILABLE: down',
    );
    expect(exit).toHaveBeenCalledWith(1);
    // Flush must happen before exit or the buffered line can be lost.
    expect(order).toEqual(['fatal', 'flush', 'exit']);
  });
});
