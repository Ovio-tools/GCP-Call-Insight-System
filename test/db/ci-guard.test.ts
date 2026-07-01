import { describe, expect, it } from 'vitest';

/**
 * The DB-integration tests skip without TEST_DATABASE_URL. That is fine locally, but
 * under CI they are the Task 1.1 acceptance criteria and must NOT silently skip — so
 * fail loudly if CI ran the suite without a database. Always runs (no skipIf).
 */
describe('CI DB-suite guard', () => {
  it('requires TEST_DATABASE_URL when running under CI', () => {
    if (process.env.CI) {
      expect(
        process.env.TEST_DATABASE_URL,
        'CI must set TEST_DATABASE_URL so the DB suite runs (see migrations/README.md)',
      ).toBeTruthy();
    } else {
      // Local run without CI: DB tests are allowed to skip.
      expect(true).toBe(true);
    }
  });
});
