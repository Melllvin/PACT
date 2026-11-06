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
    await expectInView(page, page.getByRole('complementary', { name: 'Agents' }));
    await expectInView(page, page.getByRole('toolbar', { name: 'Vues' }));
    await expectNoOverflow(page);
    await capture(page, 'tiles', size.width);
  });
}

// 006 Phase 4 — T021 (orchestrator and five agents) and T052 (grid without an orchestrator):
// at most 3 columns × 2 rows in the visible height, then a vertical scroll, never a horizontal
// one (FR-010, FR-010a, FR-010b; #40, #41, #47).
const SMALL = { width: 1024, height: 768 };
const MIN_TILE_HEIGHT = 120;

const rect = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box ?? { x: 0, y: 0, width: 0, height: 0 };
};

/** The tile shows in full inside the grid, as it is scrolled now. */
async function expectInGrid(grid: Locator, tile: Locator) {
  const [g, t] = [await rect(grid), await rect(tile)];
  expect(t.x).toBeGreaterThanOrEqual(g.x - 0.5);
  expect(t.y).toBeGreaterThanOrEqual(g.y - 0.5);
  expect(t.x + t.width).toBeLessThanOrEqual(g.x + g.width + 0.5);
  expect(t.y + t.height).toBeLessThanOrEqual(g.y + g.height + 0.5);
}

/** The grid never scrolls sideways; it scrolls vertically when its content is taller. */
const scrolls = (grid: Locator) =>
  grid.evaluate((el) => ({
    horizontal: el.scrollWidth - el.clientWidth,
    overflowY: getComputedStyle(el).overflowY,
    scrollable: el.scrollHeight - el.clientHeight,
  }));

test('lays an orchestrator and five agents out in 3 columns, the rest by scrolling (T021)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('orchestra-five-agents'),
    },
  });
  const page = await launched.app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(SMALL);
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  await expect(tile(1)).toHaveAttribute('data-state', 'awaiting-prompt');
  await tile(1).locator('.xterm').click();
  await page.keyboard.type('b1|b2|b3|b4|b5|Écris la fonction');
  await page.keyboard.press('Enter');
  const grid = page.getByRole('region', { name: 'Tuiles' });
  await expect(grid.getByRole('article')).toHaveCount(6, { timeout: 30_000 });

  const [lead, a1, a2, a3, a4, a5] = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) => rect(tile(n))),
  );
  if (!lead || !a1 || !a2 || !a3 || !a4 || !a5) throw new Error('missing tile');

  // The orchestrator: the largest tile, on the two left columns and both rows.
  for (const other of [a1, a2, a3, a4, a5]) {
    expect(lead.width * lead.height).toBeGreaterThan(other.width * other.height * 3);
  }
  expect(lead.width).toBeGreaterThan(a1.width * 1.8);
  expect(lead.height).toBeGreaterThan(a1.height * 1.8);
  // Two agents in the right column, visible without scrolling.
  expect(a1.x).toBeGreaterThanOrEqual(lead.x + lead.width - 1);
  expect(a2.x).toBeCloseTo(a1.x, 0);
  await expectInGrid(grid, tile(2));
  await expectInGrid(grid, tile(3));
  // The next three share a row below, out of the visible height until the grid is scrolled.
  const row = [a3, a4, a5];
  expect(a3.x).toBeLessThan(a4.x);
  expect(a4.x).toBeLessThan(a5.x);
  for (const t of row) expect(t.y).toBeCloseTo(a3.y, 0);
  expect(a4.y).toBeGreaterThan(Math.max(lead.y + lead.height, a2.y + a2.height) - 1);
  expect(a3.x).toBeCloseTo(lead.x, 0);
  const g = await rect(grid);
  expect(a4.y + a4.height).toBeGreaterThan(g.y + g.height + 0.5);

  const before = await scrolls(grid);
  expect(before.overflowY).toMatch(/auto|scroll/);
  expect(before.scrollable).toBeGreaterThan(0);
  expect(before.horizontal).toBeLessThanOrEqual(0);
  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  for (const n of [4, 5, 6]) await expectInGrid(grid, tile(n));

  // Legible heights, and nothing scrolls sideways.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    expect((await rect(tile(n))).height).toBeGreaterThanOrEqual(MIN_TILE_HEIGHT);
  }
  expect((await scrolls(grid)).horizontal).toBeLessThanOrEqual(0);
  await expectNoOverflow(page);
  await capture(page, 'lead-tiles', SMALL.width);
});

/** Launches `agents` fake agents and `terminals` free terminals from the quick launcher. */
async function launchMany(page: Page, agents: number, terminals: number) {
  await answerFolderPickers((launched as LaunchedApp).app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), agents);
  if (terminals > 0)
    await setCount(launcher.getByRole('group', { name: 'Terminal libre' }), terminals);
  await launcher
    .getByRole('button', { name: new RegExp(`^Lancer ${String(agents)} agents?`) })
    .click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
}

test('lets one terminal take the whole grid (T052, FR-010a)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('ask-then-crash'),
    },
  });
  const page = await launched.app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(SMALL);
  await launchMany(page, 1, 0);
  const grid = page.getByRole('region', { name: 'Tuiles' });
  const tiles = grid.getByRole('article');
  await expect(tiles).toHaveCount(1);
  const [g, t] = [await rect(grid), await rect(tiles.first())];
  // The tile fills the grid (a few pixels of border or gap at most), and no « + » beside it.
  expect(t.width).toBeGreaterThan(g.width - 24);
  expect(t.height).toBeGreaterThan(g.height - 24);
  await expect(page.getByRole('button', { name: 'Ajouter un agent' })).toHaveCount(0);
  await expectNoOverflow(page);
});

test('shows 3×2 of seven terminals, the seventh by scrolling, with or without À faire (T052)', async () => {
  test.setTimeout(180_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('ask-then-crash'),
    },
  });
  const page = await launched.app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(SMALL);
  await launchMany(page, 6, 1);
  const grid = page.getByRole('region', { name: 'Tuiles' });
  const tiles = grid.getByRole('article');
  await expect(tiles).toHaveCount(7, { timeout: 30_000 });

  const columnsAndRows = async () => {
    const boxes = await Promise.all((await tiles.all()).map((tile) => rect(tile)));
    const first = boxes.slice(0, 6);
    return {
      xs: new Set(first.map((b) => Math.round(b.x))).size,
      ys: new Set(first.map((b) => Math.round(b.y))).size,
      seventh: boxes[6],
    };
  };

  for (const open of [true, false]) {
    const toggle = page.getByRole('button', { name: /^Agents/ });
    if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click();
    await expect(page.getByRole('complementary', { name: 'Agents' })).toHaveCount(open ? 1 : 0);
    // 3 columns × 2 rows in the visible height, whether the column « Agents » is open or not.
    await expect.poll(async () => (await columnsAndRows()).xs).toBe(3);
    const { ys, seventh } = await columnsAndRows();
    expect(ys).toBe(2);
    for (let n = 0; n < 6; n++) await expectInGrid(grid, tiles.nth(n));
    // The seventh is on a third row, out of the visible height until the grid is scrolled.
    const g = await rect(grid);
    expect(seventh?.y ?? 0).toBeGreaterThan(g.y + g.height - 1);
    const s = await scrolls(grid);
    expect(s.overflowY).toMatch(/auto|scroll/);
    expect(s.horizontal).toBeLessThanOrEqual(0);
    await grid.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expectInGrid(grid, tiles.nth(6));
    await grid.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expectNoOverflow(page);
  }
  await capture(page, 'seven-terminals', SMALL.width);
});
