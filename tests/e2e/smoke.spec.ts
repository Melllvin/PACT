import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch-app';

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.close();
});

test('opens a PACT window without console errors', async () => {
  const page = await launched.app.firstWindow();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  // Reload so preload and renderer errors emitted during startup are captured too.
  await page.reload();

  await expect(page).toHaveTitle('PACT');
  await expect(page.getByRole('heading', { level: 1, name: 'PACT' })).toBeVisible();
  expect(await page.evaluate(() => typeof (globalThis as { pact?: unknown }).pact)).toBe('object');
  expect(errors).toEqual([]);
});

test('serves a strict Content-Security-Policy in the built app', async () => {
  const page = await launched.app.firstWindow();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
});

test('keeps app data in an isolated directory in test mode', async () => {
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
  expect(userData).toContain('pact-e2e-');
});
