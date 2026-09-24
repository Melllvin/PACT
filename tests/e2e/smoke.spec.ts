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
  expect(await page.evaluate(() => typeof (window as { pact?: unknown }).pact)).toBe('object');
  expect(errors).toEqual([]);
});

test('starts on the home tab with the state loaded from the main process', async () => {
  const page = await launched.app.firstWindow();
  await expect(page.getByRole('tab', { name: 'Accueil' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('note', { name: 'Légende' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
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

test('loads the embedded 1c fonts', async () => {
  const page = await launched.app.firstWindow();
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('13px "Instrument Sans"');
    await document.fonts.load('13px "JetBrains Mono"');
    return [
      document.fonts.check('13px "Instrument Sans"'),
      document.fonts.check('13px "JetBrains Mono"'),
    ];
  });
  expect(loaded).toEqual([true, true]);
});

test('keeps app data in an isolated directory in test mode', async () => {
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
  expect(userData).toContain('pact-e2e-');
});
