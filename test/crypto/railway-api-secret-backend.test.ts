import { describe, expect, it, vi } from 'vitest';
import { RailwayApiSecretBackend } from '../../src/crypto/railway-api-secret-backend.js';

function fetchReturning(json: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(json),
  });
}
const opts = { token: 't', environmentId: 'env-1', serviceId: 'svc-1' };

describe('RailwayApiSecretBackend', () => {
  it('read returns the decoded variable value', async () => {
    const fetchMock = fetchReturning({
      data: { variables: { CRYPTO_KEK_MATERIAL: '{"active":{}}' } },
    });
    const backend = new RailwayApiSecretBackend({ ...opts, fetch: fetchMock });
    expect(await backend.read('CRYPTO_KEK_MATERIAL')).toBe('{"active":{}}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('read returns undefined for an absent variable', async () => {
    const backend = new RailwayApiSecretBackend({
      ...opts,
      fetch: fetchReturning({ data: { variables: {} } }),
    });
    expect(await backend.read('NOPE')).toBeUndefined();
  });
  it('write issues a variableUpsert mutation and never logs the value', async () => {
    const fetchMock = fetchReturning({ data: { variableUpsert: true } });
    const backend = new RailwayApiSecretBackend({ ...opts, fetch: fetchMock });
    await backend.write('CRYPTO_KEK_MATERIAL', '{"active":{"kek-1":{"bytes":"x"}}}');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as {
      query: string;
      variables: { value: string };
    };
    expect(body.query).toMatch(/variableUpsert/);
    expect(body.variables.value).toBe('{"active":{"kek-1":{"bytes":"x"}}}');
  });
  it('throws on a GraphQL error response', async () => {
    const backend = new RailwayApiSecretBackend({
      ...opts,
      fetch: fetchReturning({ errors: [{ message: 'nope' }] }),
    });
    await expect(backend.read('X')).rejects.toThrow(/Railway API/);
  });
  it('write rethrows a GENERIC error that cannot contain the submitted value', async () => {
    const value = '{"active":{"kek-1":{"bytes":"leaked-secret"}}}';
    // Simulate Railway echoing the submitted value back in a validation error message.
    const backend = new RailwayApiSecretBackend({
      ...opts,
      fetch: fetchReturning({ errors: [{ message: `invalid value: ${value}` }] }),
    });
    const err = await backend.write('CRYPTO_KEK_MATERIAL', value).catch((e: unknown) => e as Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/Railway API/);
    expect(msg).not.toContain(value);
  });
});
