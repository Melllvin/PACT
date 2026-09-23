import { _electron as electron } from '@playwright/test';
export const launchApp = () =>
  electron.launch({ args: ['out/main/index.js'], env: { ...process.env, PACT_TEST_MODE: '1' } });
