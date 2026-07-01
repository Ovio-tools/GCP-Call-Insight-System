import { describe, expect, it } from 'vitest';

/**
 * The worker/queue integration tests skip without TEST_REDIS_URL. Fine locally, but under CI
 * they are the Task 2.1 acceptance criteria and must NOT silently skip — so fail loudly if CI
 * ran the suite without a Redis. Mirrors test/db/ci-guard.test.ts. Always runs (no skipIf).
 */
describe('CI queue-suite guard', () => {
  it('requires TEST_REDIS_URL when running under CI', () => {
    if (process.env.CI) {
      expect(
        process.env.TEST_REDIS_URL,
        'CI must set TEST_REDIS_URL so the worker/queue suite runs',
      ).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });
});
