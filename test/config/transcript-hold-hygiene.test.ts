import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { REQUIRED_ENV } from '../_config.js';

// REQUIRED_ENV supplies the review-queue + retention fields that have no schema default;
// without them the base object never parses.
const base = { NODE_ENV: 'test', LOG_LEVEL: 'info', ...REQUIRED_ENV };
const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

describe('config — PREFILTER_MIN_DURATION_MS', () => {
  it('defaults to 5000 ms', () => {
    // Load-bearing: this default is what actually filters production traffic. The evidence for
    // it is the live corpus — the shortest call EVER to complete the pipeline was 28,490 ms,
    // so 5 s keeps a ~5.7x margin. Changing it is a policy decision, not a tidy-up.
    expect(configSchema.parse({ ...base }).PREFILTER_MIN_DURATION_MS).toBe(5000);
  });

  it('accepts 0 to disable the rule entirely', () => {
    expect(
      configSchema.parse({ ...base, PREFILTER_MIN_DURATION_MS: '0' }).PREFILTER_MIN_DURATION_MS,
    ).toBe(0);
  });

  it('rejects a negative threshold', () => {
    expect(() => configSchema.parse({ ...base, PREFILTER_MIN_DURATION_MS: '-1' })).toThrow();
  });

  it('is documented in .env.example with the same default', () => {
    expect(example).toContain('PREFILTER_MIN_DURATION_MS=5000');
  });
});

describe('config — transcript-hold auto-close', () => {
  it('defaults to a 24 h window with the duty enabled', () => {
    const parsed = configSchema.parse({ ...base });
    expect(parsed.TRANSCRIPT_ABANDON_AFTER_MS).toBe(86_400_000);
    expect(parsed.TRANSCRIPT_ABANDON_ENABLED).toBe(true);
  });

  it('treats the kill switch as an explicit string enum, never truthy coercion', () => {
    expect(
      configSchema.parse({ ...base, TRANSCRIPT_ABANDON_ENABLED: 'false' })
        .TRANSCRIPT_ABANDON_ENABLED,
    ).toBe(false);
    // A stray value must fail loudly rather than silently read as "on".
    expect(() => configSchema.parse({ ...base, TRANSCRIPT_ABANDON_ENABLED: 'yes' })).toThrow();
  });

  it('refuses a window that does not outlast the transcript wait', () => {
    // Otherwise a hold could be abandoned while the pipeline is still legitimately waiting.
    expect(() =>
      configSchema.parse({
        ...base,
        DIALPAD_TRANSCRIPT_WAIT_MAX_MS: '1800000',
        TRANSCRIPT_ABANDON_AFTER_MS: '1800000',
      }),
    ).toThrow(/TRANSCRIPT_ABANDON_AFTER_MS/);
  });

  it('accepts a window just beyond the transcript wait', () => {
    const parsed = configSchema.parse({
      ...base,
      DIALPAD_TRANSCRIPT_WAIT_MAX_MS: '1800000',
      TRANSCRIPT_ABANDON_AFTER_MS: '1800001',
    });
    expect(parsed.TRANSCRIPT_ABANDON_AFTER_MS).toBe(1_800_001);
  });

  it('is documented in .env.example', () => {
    expect(example).toContain('TRANSCRIPT_ABANDON_AFTER_MS');
    expect(example).toContain('TRANSCRIPT_ABANDON_ENABLED');
  });
});
