import { describe, expect, it, vi } from 'vitest';
import { keepAlive } from '../src/boot/keepalive.js';

describe('keepAlive', () => {
  it('acquires a keepalive hold and releases it on shutdown', async () => {
    let fire: () => void = () => {
      /* replaced when keepAlive registers */
    };
    const release = vi.fn();
    const hold = vi.fn(() => release);

    const promise = keepAlive({ register: (handler) => (fire = handler), hold });

    let resolved = false;
    void promise.then(() => (resolved = true));

    // Hold is acquired immediately and not yet released; promise still pending.
    await Promise.resolve();
    expect(hold).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(resolved).toBe(false);

    fire();
    await promise;
    expect(release).toHaveBeenCalledTimes(1); // the ref'd handle is cleared
    expect(resolved).toBe(true);
  });

  it('default hold creates and clears a timer so the event loop stays alive', async () => {
    // Proves the DEFAULT implementation refs a timer (not just that an injected
    // callback can resolve): a pending promise + signal listener alone would NOT
    // keep Node's event loop alive.
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    let fire: () => void = () => {
      /* replaced when keepAlive registers */
    };

    const promise = keepAlive({ register: (handler) => (fire = handler) });
    await Promise.resolve();
    expect(setSpy).toHaveBeenCalled();

    fire();
    await promise;
    expect(clearSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
