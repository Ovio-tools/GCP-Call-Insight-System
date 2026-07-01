import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    // The DB-integration tests in test/db share one Postgres and run migrations in
    // beforeAll; running test files in parallel would race those migrations. The suite
    // is small, so serialize files rather than add per-test locking.
    fileParallelism: false,
  },
});
