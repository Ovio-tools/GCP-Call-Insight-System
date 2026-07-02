import { describe, expect, it, vi } from 'vitest';
import { buildDialpadAuthHeaders, requireDialpadApiKey } from '../../../src/dialpad/client/auth.js';
import { createDialpadClient } from '../../../src/dialpad/client/client.js';
import type { Limiter } from '../../../src/dialpad/client/limiter.js';
import { ConfigError } from '../../../src/config/index.js';
import { makeTestConfig } from '../../_config.js';

const passLimiter: Limiter = { acquire: () => Promise.resolve() };

describe('Dialpad auth', () => {
  it('builds a Bearer header from the configured key', () => {
    const config = makeTestConfig({ DIALPAD_API_KEY: 'sekret-key' });
    expect(buildDialpadAuthHeaders(config)).toEqual({ Authorization: 'Bearer sekret-key' });
  });

  it('fails fast with CONFIG_MISSING_OR_INVALID naming DIALPAD_API_KEY when absent', () => {
    const config = makeTestConfig(); // DIALPAD_API_KEY optional → absent
    expect(() => requireDialpadApiKey(config)).toThrowError(ConfigError);
    try {
      requireDialpadApiKey(config);
    } catch (err) {
      const e = err as ConfigError;
      expect(e.code).toBe('CONFIG_MISSING_OR_INVALID');
      expect(e.invalid).toContain('DIALPAD_API_KEY');
      expect(e.message).toContain('DIALPAD_API_KEY');
    }
  });

  it('sends the Bearer header and correct path on a real request, without exposing the key in logs', async () => {
    const config = makeTestConfig({
      DIALPAD_API_KEY: 'sekret-key',
      DIALPAD_BASE_URL: 'https://dialpad.test/api/v2',
    });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(new Response(JSON.stringify({ lines: [{ content: 'hi' }] })));
    });
    const client = createDialpadClient({
      config,
      limiter: passLimiter,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.fetchTranscript('call-42');

    expect(seen[0]?.url).toBe('https://dialpad.test/api/v2/transcripts/call-42');
    expect(seen[0]?.headers).toMatchObject({ Authorization: 'Bearer sekret-key' });
  });

  it('fails fast at client construction (real fetch) when the key is missing', () => {
    const config = makeTestConfig(); // no DIALPAD_API_KEY
    try {
      createDialpadClient({ config, limiter: passLimiter });
      throw new Error('expected construction to throw');
    } catch (err) {
      const e = err as ConfigError;
      expect(e).toBeInstanceOf(ConfigError);
      expect(e.code).toBe('CONFIG_MISSING_OR_INVALID');
      expect(e.invalid).toContain('DIALPAD_API_KEY');
    }
  });

  it('skips the key check only when skipAuthValidationForTests is set (not just any fetchImpl)', () => {
    const config = makeTestConfig(); // no key
    const fetchImpl = vi.fn((_url: string) => Promise.resolve(new Response('{}')));

    // Injecting a fetchImpl alone must NOT bypass validation — the check is explicit.
    expect(() =>
      createDialpadClient({
        config,
        limiter: passLimiter,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toThrowError(ConfigError);

    // The explicit test-only opt-out does bypass it.
    expect(() =>
      createDialpadClient({
        config,
        limiter: passLimiter,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        skipAuthValidationForTests: true,
      }),
    ).not.toThrow();
  });
});
