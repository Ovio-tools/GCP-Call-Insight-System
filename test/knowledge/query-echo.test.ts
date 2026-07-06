import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness } from './_harness.js';
import { login } from '../http/_helpers.js';

/**
 * A PII-shaped free-text `q` must never reflect back (Findings 1, 2 & 4). The route runs the pure
 * `scanKnowledgeQuery` BEFORE any DB read or response, so an unsafe `q` throws REQUEST_MALFORMED and
 * the value never enters the response body, an export href, the HTML form, or a log line. Because it
 * fails before the DB, a dummy pool suffices.
 */
const LEAK = 'verboten';
const DENY = [LEAK];

describe('knowledge query echo guard (Task 10.1)', () => {
  it('HTML: 400 and renders no knowledge page/form/export links, no value', async () => {
    const harness = await makeKnowledgeHarness({} as unknown as Pool, { denyTerms: DENY });
    const { cookie } = await login(harness);
    const res = await harness.app.inject({
      method: 'GET',
      url: `/knowledge?q=${LEAK}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(LEAK);
    expect(res.body).not.toContain('Knowledge base');
    expect(res.body).not.toContain('<form');
    expect(res.body).not.toContain('export.csv');
    expect(harness.lines.join('\n')).not.toContain(LEAK);
    await harness.app.close();
  });

  it('JSON view + both exports: 400 with the shared error body, none of the value', async () => {
    const harness = await makeKnowledgeHarness({} as unknown as Pool, { denyTerms: DENY });
    const { cookie } = await login(harness);
    for (const url of [
      `/knowledge.json?q=${LEAK}`,
      `/knowledge/export.csv?q=${LEAK}`,
      `/knowledge/export.json?q=${LEAK}`,
    ]) {
      const res = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(400);
      const body = res.json<{ error: string; message: string; request_id: string }>();
      expect(body.error).toBe('REQUEST_MALFORMED');
      expect(JSON.stringify(body), url).not.toContain(LEAK);
    }
    expect(harness.lines.join('\n')).not.toContain(LEAK);
    await harness.app.close();
  });
});
