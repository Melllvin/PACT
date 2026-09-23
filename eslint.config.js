import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default tseslint.config(
  {
    ignores: [
      'out',
      'dist',
      'coverage',
      '.tsbuild',
      'node_modules',
      'test-results',
      'playwright-report',
      'docs/maquettes/**',
      'tests/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: { '@typescript-eslint/no-explicit-any': 'error', ...hooks.configs.recommended.rules },
  },
);
