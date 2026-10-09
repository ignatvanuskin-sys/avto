import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Flat config for ESLint 9+/10.
 *
 * The repository previously shipped a `lint` script without any config file,
 * so `npm run lint` failed outright. This is the missing half.
 *
 * `supabase/functions` is ignored on purpose: those files run on Deno with
 * different globals and are not part of the Node/TypeScript project that
 * `tsc --noEmit` checks.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'public/**',
      'supabase/generated/**',
      'supabase/functions/**',
      '.trash/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-explicit-any': 'error',
      // console output is a build-time concern; the app must not log to the
      // console, but the pipeline scripts legitimately print progress.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Pipeline scripts run in Node, so the Node globals must be declared here —
    // without a `globals` package this is the minimal set they actually use.
    files: ['scripts/**/*.{ts,mjs}', 'tests/**/*.ts', 'playwright.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
