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
  await expect(page.getByRole('tab', { name: 'Nouvel onglet' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('note', { name: 'Légende' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('serves a Content-Security-Policy strict on scripts in the built app', async () => {
  const page = await launched.app.firstWindow();
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).not.toContain('unsafe-eval');
  // Injected styles only (xterm, Radix): scripts stay strict (research.md R11).
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
});

test('loads the embedded fonts: Geist for the interface, JetBrains Mono for the terminals', async () => {
  const page = await launched.app.firstWindow();
  const loaded = await page.evaluate(async () => {
    const fonts = ['13px "Geist"', '13px "Geist Mono"', '13px "JetBrains Mono"'];
    await Promise.all(fonts.map((font) => document.fonts.load(font)));
    return fonts.map((font) => document.fonts.check(font));
  });
  expect(loaded).toEqual([true, true, true]);
});

test('keeps app data in an isolated directory in test mode', async () => {
  const userData = await launched.app.evaluate(({ app }) => app.getPath('userData'));
  expect(userData).toContain('pact-e2e-');
});

test('paints the ambient canvas behind the home tab, not over its content (R17)', async () => {
  const page = await launched.app.firstWindow();
  // Pinned: Windows runners may turn animations off, which the effects honour.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const canvas = page.locator('canvas[aria-hidden="true"]');
  await expect(canvas).toHaveCount(1);
  // Clicks go through to the page: the canvas is out of the pointer's way.
  expect(await canvas.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect(page.getByRole('button', { name: 'Choisir un dépôt Git…' })).toBeVisible();
});

// T125: the CI replays this file and us2 on the app packaged by `electron-builder --dir`.
test('runs the packaged app when PACT_E2E_PACKAGED=1, the built sources otherwise', async () => {
  const packaged = await launched.app.evaluate(({ app }) => app.isPackaged);
  expect(packaged).toBe(process.env.PACT_E2E_PACKAGED === '1');
});
