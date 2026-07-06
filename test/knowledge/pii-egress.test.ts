import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { makeKnowledgeHarness, seedKnowledge } from './_harness.js';
import { login } from '../http/_helpers.js';
import { loadCorpus, normalizeValue } from '../redaction/_corpus.js';
import { hasTestDb, makePool, migrate } from '../db/_pg.js';
import { cleanupCalls, makeAppPool } from '../db/_dal.js';

/**
 * Independent surface backstop (Findings 1, 2 & 5). Normal pipeline storage is already protected by
 * the Task 5.2 second PII scan (fail-closed hold) — a labeled-corpus value never reaches the store.
 * This test proves the surface's OWN value-level residual guard: even with PII planted DIRECTLY into
 * `structured_knowledge` (scalar + array fields), no residual-detectable value egresses through the
 * CSV export, `export.json`, the HTML page, `/knowledge.json`, or the summary.
 *
 * The surface runs NO NER model — its guard is the residual scan (deny-list + regex categories) — so
 * we plant values the residual scan detects: client deny-list terms, a digit run, and an email.
 */
const PATTERN = 'test-kpii-%';

describe.skipIf(!hasTestDb)('knowledge surface PII egress backstop (Task 10.1)', () => {
  let owner!: Pool;
  let app!: Pool;
  const corpus = loadCorpus('corpus.json');
  const denyTerms = corpus.denyTerms;

  // One residual-detectable value per category, planted across scalar + array fields.
  const DENY_A = denyTerms[0] ?? 'Acme Plumbing'; // deny_list_term
  const DENY_B = denyTerms[1] ?? DENY_A; // deny_list_term (array)
  const PHONE = '5551234567'; // digit_run
  const EMAIL = 'john.doe@example.com'; // email_like
  const PLANTED = [DENY_A, DENY_B, PHONE, EMAIL];

  beforeAll(async () => {
    await migrate('up');
    owner = makePool();
    app = makeAppPool();
  });
  beforeEach(async () => {
    await cleanupCalls(owner, PATTERN);
  });
  afterAll(async () => {
    await cleanupCalls(owner, PATTERN);
    await owner.end();
    await app.end();
  });

  it('scrubs planted PII from every output shape', async () => {
    await seedKnowledge(owner, app, {
      callId: 'test-kpii-1',
      createdAt: '2026-07-01T00:00:00Z',
      problemStatement: `serving ${DENY_A} today`,
      acquisitionSource: `call ${PHONE}`,
      customerLanguage: [`email me at ${EMAIL}`, 'a genuinely clean phrase'],
      concerns: [`worried about ${DENY_B}`, 'clean concern'],
    });

    const harness = await makeKnowledgeHarness(app, { denyTerms });
    const { cookie } = await login(harness);

    const bodies: Record<string, string> = {};
    for (const url of [
      '/knowledge',
      '/knowledge.json',
      '/knowledge/export.csv',
      '/knowledge/export.json',
    ]) {
      const res = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      bodies[url] = res.body;
    }

    for (const [url, body] of Object.entries(bodies)) {
      const normalizedBody = normalizeValue(body);
      for (const value of PLANTED) {
        // Assert by value; the message redacts it (corpus-recall convention).
        expect(
          normalizedBody.includes(normalizeValue(value)),
          `planted value #${PLANTED.indexOf(value)} leaked into ${url}`,
        ).toBe(false);
      }
    }

    // Sanity: the clean phrases DID survive (the row isn't just empty).
    expect(bodies['/knowledge.json']).toContain('a genuinely clean phrase');
    expect(bodies['/knowledge.json']).toContain('clean concern');
    await harness.app.close();
  });
});
