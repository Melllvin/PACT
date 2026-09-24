import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      '.tsbuild/**',
      'test-results/**',
      'playwright-report/**',
      'docs/**',
      '.agents/**',
      '.claude/**',
      '.specify/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/unit/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
