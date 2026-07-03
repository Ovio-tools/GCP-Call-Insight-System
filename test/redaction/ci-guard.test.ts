import { describe, expect, it } from 'vitest';

/**
 * The NER/recall suites skip without TEST_NER_MODEL_DIR. That is fine locally,
 * but under CI they are the Task 4.1 privacy-boundary acceptance criteria (the
 * corpus recall gate + no-egress test) and must NOT silently skip — fail loudly
 * if CI ran without the vendored model. Always runs (no skipIf).
 */
describe('CI NER-suite guard', () => {
  it('requires TEST_NER_MODEL_DIR when running under CI', () => {
    if (process.env.CI) {
      expect(
        process.env.TEST_NER_MODEL_DIR,
        'CI must set TEST_NER_MODEL_DIR so the redaction recall gate runs (npm run model:fetch)',
      ).toBeTruthy();
    } else {
      expect(true).toBe(true);
    }
  });
});
