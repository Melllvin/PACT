import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  use: { trace: 'retain-on-failure' },
  timeout: 30000,
});
