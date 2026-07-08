import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateEnv, CONFIG_ERROR_CODE, ConfigError } from '../../src/config/index.js';
import { requireRedactionConfig } from '../../src/redaction/config.js';
import { makeTestConfig, REQUIRED_ENV } from '../_config.js';

/** A base64 key that decodes to exactly 32 bytes — the minimum valid hash key. */
const VALID_KEY = randomBytes(32).toString('base64');

describe('redaction config schema', () => {
  it('accepts a valid base64 key of >= 32 decoded bytes', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_VALUE_HASH_KEY: VALID_KEY,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an absent key (optional at boot; consumers enforce presence)', () => {
    const result = validateEnv({ NODE_ENV: 'test', ...REQUIRED_ENV });
    expect(result.ok).toBe(true);
  });

  it('rejects a key that is not valid base64, naming the variable', () => {
    const result = validateEnv({
      ...REQUIRED_ENV,
      NODE_ENV: 'test',
      REDACTION_VALUE_HASH_KEY: '!!!not-base64-at-all!!!',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REDACTION_VALUE_HASH_KEY');
  });

  it('rejects a key that decodes to fewer than 32 bytes', () => {
    const short = randomBytes(16).toString('base64');
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_VALUE_HASH_KEY: short,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REDACTION_VALUE_HASH_KEY');
  });

  it('validates the redaction tuning knobs with sane defaults', () => {
    const result = validateEnv({ NODE_ENV: 'test', ...REQUIRED_ENV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.REDACTION_RISK_THRESHOLD).toBeGreaterThan(0);
    expect(result.config.REDACTION_RISK_THRESHOLD).toBeLessThanOrEqual(1);
    expect(result.config.REDACTION_RECALL_TARGET).toBeGreaterThan(0);
    expect(result.config.REDACTION_NER_MODEL_ID).toBe('Xenova/bert-base-NER');
    expect(result.config.REDACTION_NER_CHUNK_OVERLAP_CHARS).toBeLessThan(
      result.config.REDACTION_NER_CHUNK_CHARS,
    );
  });

  it('defaults REDACTION_NER_ENTITY_SCOPE to person + numbered_location', () => {
    const result = validateEnv({ NODE_ENV: 'test', ...REQUIRED_ENV });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.REDACTION_NER_ENTITY_SCOPE).toEqual(['person', 'numbered_location']);
  });

  it('parses a CSV entity scope with whitespace and accepts every known member', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_NER_ENTITY_SCOPE: ' person, numbered_location , location,organization,misc ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.REDACTION_NER_ENTITY_SCOPE).toEqual([
      'person',
      'numbered_location',
      'location',
      'organization',
      'misc',
    ]);
  });

  it('rejects an unknown entity-scope member, naming the variable', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_NER_ENTITY_SCOPE: 'person,cities',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REDACTION_NER_ENTITY_SCOPE');
  });

  it('rejects an empty entity scope, naming the variable', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_NER_ENTITY_SCOPE: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REDACTION_NER_ENTITY_SCOPE');
  });

  it('rejects an out-of-range risk threshold', () => {
    const result = validateEnv({
      NODE_ENV: 'test',
      ...REQUIRED_ENV,
      REDACTION_RISK_THRESHOLD: '1.5',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.invalid).toContain('REDACTION_RISK_THRESHOLD');
  });
});

describe('requireRedactionConfig', () => {
  it('throws CONFIG_MISSING_OR_INVALID naming REDACTION_VALUE_HASH_KEY when absent', () => {
    const config = makeTestConfig();
    expect(() => requireRedactionConfig(config)).toThrow(ConfigError);
    try {
      requireRedactionConfig(config);
    } catch (err) {
      const e = err as ConfigError;
      expect(e.code).toBe(CONFIG_ERROR_CODE);
      expect(e.invalid).toContain('REDACTION_VALUE_HASH_KEY');
      expect(e.message).toContain('REDACTION_VALUE_HASH_KEY');
    }
  });

  it('returns the decoded hash key when present and valid', () => {
    const config = makeTestConfig({ REDACTION_VALUE_HASH_KEY: VALID_KEY });
    const { valueHashKey } = requireRedactionConfig(config);
    expect(valueHashKey).toEqual(Buffer.from(VALID_KEY, 'base64'));
    expect(valueHashKey.length).toBeGreaterThanOrEqual(32);
  });

  it('throws naming REDACTION_DENY_LIST_PATH when the path is set but unreadable', () => {
    const config = makeTestConfig({
      REDACTION_VALUE_HASH_KEY: VALID_KEY,
      REDACTION_DENY_LIST_PATH: '/nonexistent/deny-list.txt',
    });
    expect(() => requireRedactionConfig(config)).toThrow(/REDACTION_DENY_LIST_PATH/);
  });
});
