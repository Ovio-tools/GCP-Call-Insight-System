import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RedactionError, assertNoContentFields, isContentField } from '../src/logging/redaction.js';
import { createRootLogger } from '../src/logging/logger.js';

/** A sink that collects emitted log lines so tests don't write to stdout. */
function collectingSink(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('redaction guard', () => {
  it('flags known content fields case-insensitively', () => {
    expect(isContentField('transcript')).toBe(true);
    expect(isContentField('Transcript')).toBe(true);
    expect(isContentField('customer_email')).toBe(true);
    expect(isContentField('call_id')).toBe(false);
  });

  it('throws naming the offending field, including when nested', () => {
    expect(() => assertNoContentFields({ call_id: 'c-1', transcript: 'hello' })).toThrow(
      RedactionError,
    );
    expect(() => assertNoContentFields({ data: { nested: { ssn: '123' } } })).toThrow(/ssn/);
  });

  it('allows safe metadata', () => {
    expect(() =>
      assertNoContentFields({ call_id: 'c-1', node_env: 'test', port: 8080 }),
    ).not.toThrow();
  });

  it('makes the logger refuse to emit a known content field', () => {
    const { lines, stream } = collectingSink();
    const log = createRootLogger({ level: 'info', destination: stream });

    // The guard throws before anything is written.
    expect(() => log.info({ call_id: 'c-1', transcript: 'secret words' })).toThrow(RedactionError);
    expect(lines.join('')).not.toContain('secret words');

    // A clean line passes through and carries the call_id.
    expect(() => log.info({ call_id: 'c-1' }, 'ok')).not.toThrow();
    expect(lines.join('')).toContain('"call_id":"c-1"');
  });

  it('does not read raw env: a bogus LOG_LEVEL cannot crash the default logger', () => {
    // The logger validates nothing — config does. So building with defaults must be
    // safe regardless of process.env, which is what keeps the boot path crash-free.
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'bogus';
    try {
      expect(() => createRootLogger()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });
});
