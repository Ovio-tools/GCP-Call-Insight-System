import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // migrations/** and migrations-raw/** are plain CommonJS (.cjs) DDL scripts run by
    // node-pg-migrate from the raw repo-root dir, never compiled or type-checked. Type-aware
    // linting can't resolve them (not in tsconfig) and would flag CJS `exports`/`require`, so skip.
    // (migrations-raw is the DB-B raw-store set — ADR 0008 Move 2.)
    // deploy/railway/*.cjs are dependency-free one-off ops scripts run as a Railway startCommand,
    // likewise plain CommonJS outside tsconfig.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'migrations/**',
      'migrations-raw/**',
      'deploy/railway/*.cjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
