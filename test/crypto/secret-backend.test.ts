import { describe, expect, it } from 'vitest';
import {
  EnvSecretBackend,
  InMemorySecretBackend,
  ReadOnlySecretBackendError,
} from '../../src/crypto/secret-backend.js';

describe('InMemorySecretBackend', () => {
  it('returns undefined for an unset name and round-trips writes', async () => {
    const backend = new InMemorySecretBackend();
    expect(await backend.read('A')).toBeUndefined();
    await backend.write('A', 'value-1');
    expect(await backend.read('A')).toBe('value-1');
    await backend.write('A', 'value-2');
    expect(await backend.read('A')).toBe('value-2');
  });
});

describe('EnvSecretBackend', () => {
  it('reads from the supplied values map', async () => {
    const backend = new EnvSecretBackend({ A: 'x', B: undefined });
    expect(await backend.read('A')).toBe('x');
    expect(await backend.read('B')).toBeUndefined();
    expect(await backend.read('C')).toBeUndefined();
  });

  it('rejects writes with ReadOnlySecretBackendError', async () => {
    const backend = new EnvSecretBackend({ A: 'x' });
    await expect(backend.write('A', 'y')).rejects.toBeInstanceOf(ReadOnlySecretBackendError);
  });
});
