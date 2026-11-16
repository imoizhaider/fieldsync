import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'artifacts/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  { files: ['src/**/*.js'], languageOptions: { globals: { ...globals.browser } } },
  { files: ['src/sw.js'], languageOptions: { globals: { ...globals.serviceworker, __PRECACHE__: 'readonly' } } },
  { files: ['scripts/**', 'tests/**', '*.js', '*.mjs'], languageOptions: { globals: { ...globals.node } } },
  { files: ['tests/e2e/**', 'tests/qa/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
