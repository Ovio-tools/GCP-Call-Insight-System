import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatPingError, httpPing, sanitizePingError } from '../../src/heartbeat/ping.js';

const URL_WITH_SECRET = 'https://checks.example.com/ping/super-secret-check-id';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('httpPing', () => {
  it('GETs the URL and resolves on a 2xx response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(httpPing(5_000)(URL_WITH_SECRET)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(URL_WITH_SECRET);
    expect((init as RequestInit).method).toBe('GET');
  });

  it('throws a HeartbeatPingError carrying the status number but NOT the URL on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const err = await httpPing(5_000)(URL_WITH_SECRET).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HeartbeatPingError);
    expect((err as Error).message).toContain('503');
    expect((err as Error).message).not.toContain('super-secret-check-id');
    expect((err as Error).message).not.toContain('checks.example.com');
  });

  it('normalizes a transport error so the URL embedded in fetch’s message never escapes', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`request to ${URL_WITH_SECRET} failed, reason: ECONNREFUSED`),
    );

    const err = await httpPing(5_000)(URL_WITH_SECRET).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HeartbeatPingError);
    expect((err as Error).message).not.toContain('super-secret-check-id');
    expect((err as Error).message).not.toContain('checks.example.com');
  });

  it('aborts and reports a URL-free timeout when the monitor never responds', async () => {
    vi.useFakeTimers();
    // A fetch that only rejects when its AbortSignal fires — mimics a hung monitor.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new Error(`aborted request to ${URL_WITH_SECRET}`)),
          );
        }),
    );

    const pending = httpPing(2_000)(URL_WITH_SECRET).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await pending;

    expect(err).toBeInstanceOf(HeartbeatPingError);
    expect((err as Error).message).toContain('timeout');
    expect((err as Error).message).not.toContain('super-secret-check-id');
  });
});

describe('sanitizePingError', () => {
  it('trusts a HeartbeatPingError message (built URL-free by construction)', () => {
    expect(sanitizePingError(new HeartbeatPingError('external check returned status 503'))).toBe(
      'external check returned status 503',
    );
  });

  it('reduces any other throwable to a class name, never leaking its raw message', () => {
    const out = sanitizePingError(new Error(`connect ECONNREFUSED ${URL_WITH_SECRET}`));
    expect(out).not.toContain('super-secret-check-id');
    expect(out).not.toContain('checks.example.com');
    expect(out).toContain('Error');
  });
});
