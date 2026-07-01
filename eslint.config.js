import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // migrations/** are plain CommonJS (.cjs) DDL scripts run by node-pg-migrate from
    // the raw repo-root dir, never compiled or type-checked. Type-aware linting can't
    // resolve them (not in tsconfig) and would flag CJS `exports`/`require`, so skip.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'migrations/**'],
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
