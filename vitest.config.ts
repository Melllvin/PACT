import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@shared': resolve('src/shared') };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'tests/unit/main/**/*.test.ts',
            'tests/unit/preload/**/*.test.ts',
            'tests/unit/shared/**/*.test.ts',
            'tests/unit/fixtures/**/*.test.ts',
            'tests/unit/scripts/**/*.test.ts',
            'tests/unit/assets/**/*.test.ts',
            'tests/integration/**/*.test.ts',
            'tests/contract/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/unit/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/setup/renderer.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        // Process entry points only wire Electron/React together; the e2e suite covers them.
        'src/main/index.ts',
        'src/renderer/main.tsx',
      ],
      // Constitution 1.1.0 — minimum line and branch coverage, enforced in CI.
      thresholds: {
        'src/{main,shared,preload}/**': { lines: 80, branches: 80 },
        'src/renderer/**': { lines: 70, branches: 70 },
      },
    },
  },
});
