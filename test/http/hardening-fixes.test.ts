import { describe, expect, it, vi } from 'vitest';
import {
  createInternalApp,
  createWebhookApp,
  MemoryRateStore,
  type ReplayStore,
} from '../../src/http/index.js';
import { trustedCallbackUrl } from '../../src/http/auth/oidc-provider.js';
import { makeTestConfig } from '../_config.js';
import { FakeAuthProvider, FakeClock, makeCapturingLogger } from './_helpers.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

describe('internal app — session store is required in real deployments', () => {
  it('throws CONFIG_MISSING_OR_INVALID in production without a session store', async () => {
    const config = makeTestConfig({
      NODE_ENV: 'production',
      SESSION_SECRET,
      SESSION_COOKIE_SECURE: true,
    });
    await expect(
      createInternalApp({
        config,
        authProvider: new FakeAuthProvider(),
        rateStore: new MemoryRateStore(),
      }),
    ).rejects.toMatchObject({ error_code: 'CONFIG_MISSING_OR_INVALID' });
  });

  it('allows an omitted session store in dev/test (in-memory fallback)', async () => {
    const config = makeTestConfig({
      NODE_ENV: 'test',
      SESSION_SECRET,
      SESSION_COOKIE_SECURE: false,
    });
    const app = await createInternalApp({
      config,
      authProvider: new FakeAuthProvider(),
      rateStore: new MemoryRateStore(),
    });
    await app.ready();
    await app.close();
  });
});

describe('OIDC callback URL is derived from the configured redirect URI', () => {
  it('ignores a hostile Host and keeps only the query string', () => {
    const configured = 'https://app.example.com/auth/callback';
    const hostile = 'https://attacker.example/auth/callback?code=abc&state=xyz';
    const url = trustedCallbackUrl(configured, hostile);
    expect(url.origin).toBe('https://app.example.com');
    expect(url.pathname).toBe('/auth/callback');
    expect(url.searchParams.get('code')).toBe('abc');
    expect(url.searchParams.get('state')).toBe('xyz');
  });
});

describe('webhook — commit failure does not release the reservation', () => {
  it('keeps the reservation (no release) when commit fails after the handler ran', async () => {
    const clock = new FakeClock();
    const { logger } = makeCapturingLogger();
    const release = vi.fn(() => Promise.resolve());
    const replayStore: ReplayStore = {
      reserve: () =>
        Promise.resolve({
          acquired: true,
          commit: () => Promise.reject(new Error('commit failed')),
          release,
        }),
    };

    const webhookApp = await createWebhookApp({
      config: makeTestConfig(),
      replayStore,
      rateStore: new MemoryRateStore(clock),
      clock,
      logger,
    });

    const handlerRuns: string[] = [];
    webhookApp.registerWebhook({
      path: '/webhooks/commitfail',
      provider: 'test',
      verifySignature: () => true,
      extractEventId: () => 'evt',
      extractTimestamp: () => clock.now(),
      handler: () => {
        handlerRuns.push('ran');
        return { ok: true };
      },
    });
    await webhookApp.app.ready();

    const res = await webhookApp.app.inject({
      method: 'POST',
      url: '/webhooks/commitfail',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt', ts: clock.now() }),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
    expect(handlerRuns).toEqual(['ran']); // handler ran (side effects applied)
    expect(release.mock.calls).toHaveLength(0); // reservation kept to block retries
    await webhookApp.app.close();
  });
});
