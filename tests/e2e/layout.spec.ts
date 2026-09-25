import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// T157: the home tab, the empty workspace, the quick launcher and 6 tiles at 1024 px and on a
// large screen. Layout assertions (nothing overflows, everything shows) rather than pixel
// comparisons; the captures are kept in test-results/layout/ for review.
const SIZES = [
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-layout-')));
  repo = join(root, 'atelier-web');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Sets a counter of the quick launcher to `target`. */
const setCount = async (group: Locator, target: number) => {
  const count = group.getByRole('status');
  for (;;) {
    const value = Number(await count.textContent());
    if (value === target) return;
    await group.getByRole('button', { name: value < target ? '+' : '−' }).click();
  }
};

/** The page does not scroll: each view scrolls inside its own area, if at all. */
async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow).toEqual({ x: 0, y: 0 });
}

/** The element shows in full within the window. */
async function expectInView(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
}

const capture = (page: Page, name: string, width: number) =>
  page.screenshot({ path: join('test-results', 'layout', `${name}-${String(width)}.png`) });

for (const size of SIZES) {
  test(`lays out every core screen at ${String(size.width)} × ${String(size.height)}`, async () => {
    test.setTimeout(120_000);
    launched = await launchApp({
      env: {
        PACT_FAKE_CLI: FAKE_CLI,
        PACT_FAKE_NODE: process.execPath,
        FAKE_CLI_SCENARIO: scenarioPath('ask-then-crash'),
      },
    });
    const page = await launched.app.firstWindow();
    // Still frames: the ambient effects are off under reduced motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(size);

    // Home.
    const pick = page.getByRole('button', { name: 'Choisir un dépôt Git…' });
    await expectInView(page, page.getByRole('heading', { level: 2, name: 'Ouvrir un workspace' }));
    await expectInView(page, pick);
    await expectInView(page, page.getByRole('note', { name: 'Légende' }));
    await expectNoOverflow(page);
    await capture(page, 'home', size.width);

    // Empty workspace.
    await answerFolderPickers(launched.app, repo);
    await pick.click();
    const add = page.getByRole('button', { name: /Ajouter des agents/ });
    await expectInView(page, add);
    await expectInView(page, page.getByRole('button', { name: '+ Agents' }));
    await expectNoOverflow(page);
    await capture(page, 'empty', size.width);

    // Quick launcher.
    await add.click();
    const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
    await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 6);
    await expectInView(page, launcher);
    await expectNoOverflow(page);
    await capture(page, 'quick', size.width);

    // Six tiles, 3×2, beside the À faire column.
    await launcher.getByRole('button', { name: 'Lancer 6 agents' }).click();
    await page.keyboard.press('Enter');
    // Six worktrees in one go take a while under ConPTY.
    await expect(page.getByRole('region', { name: 'Tuiles' })).toHaveAttribute(
      'data-layout',
      '3x2',
      { timeout: 20_000 },
    );
    const tiles = page.getByRole('article', { name: /^Faux CLI \d/ });
    await expect(tiles).toHaveCount(6, { timeout: 20_000 });
    for (const tile of await tiles.all()) {
      await expectInView(page, tile);
      // The tools never cover the output of the CLI.
      const tools = await tile.getByRole('toolbar', { name: 'Outils' }).boundingBox();
      const terminal = await tile.locator('.xterm').boundingBox();
      expect(tools && terminal && tools.y + tools.height <= terminal.y).toBe(true);
    }
    await expectInView(page, page.getByRole('complementary', { name: 'À faire' }));
    await expectInView(page, page.getByRole('toolbar', { name: 'Vues' }));
    await expectNoOverflow(page);
    await capture(page, 'tiles', size.width);
  });
}
