import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness } from './_harness.js';
import { login } from '../http/_helpers.js';

/**
 * Export returns ALL filtered rows, so it must REJECT pagination params (Finding 2). `.strict()` on
 * the export schema turns a stray `page`/`page_size` into REQUEST_MALFORMED before any DB read — so
 * a dummy pool is fine here.
 */
describe('knowledge export rejects pagination (Task 10.1)', () => {
  it('rejects page / page_size on the JSON and CSV exports', async () => {
    const harness = await makeKnowledgeHarness({} as unknown as Pool);
    const { cookie } = await login(harness);

    const json = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.json?page=2',
      headers: { cookie },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json<{ error: string }>().error).toBe('REQUEST_MALFORMED');

    const csv = await harness.app.inject({
      method: 'GET',
      url: '/knowledge/export.csv?page_size=5',
      headers: { cookie },
    });
    expect(csv.statusCode).toBe(400);
    expect(csv.json<{ error: string }>().error).toBe('REQUEST_MALFORMED');

    await harness.app.close();
  });
});
