import { rm } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, typeIn } from './helpers/workspace';

// 006 US2 end to end: the tiles of the agents of an orchestrator (T020, FR-010, FR-009) and the
// terminal that fills its tile (T022a, FR-021, FR-022).

const env = (scenario: string) => ({
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath(scenario),
});

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us29-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b ?? { x: 0, y: 0, width: 0, height: 0 };
};

/** Opens the repository and launches one fake agent, as the orchestrator. */
async function launchOrchestrator(page: Page, app: LaunchedApp['app']) {
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  return lead;
}

test('shows the tiles of the agents it launches beside it, at once (T020, FR-009, FR-010)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env: env('orchestra-two-agents') });
  const page = await launched.app.firstWindow();
  const lead = await launchOrchestrator(page, launched.app);

  await typeIn(page, lead, 'feat/un|feat/deux|Écris la fonction');
  // The event: the orchestrator's tool call returns. The tile follows within a second, unasked.
  await expect(lead).toContainText('Faux CLI 2 lancé sur feat/un');
  const second = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(second).toBeVisible({ timeout: 1_000 });
  await expect(lead).toContainText('Faux CLI 3 lancé sur feat/deux');
  const third = page.getByRole('article', { name: /^Faux CLI 3,/ });
  await expect(third).toBeVisible({ timeout: 1_000 });

  // FR-010: the orchestrator on the two left columns, the two agents in the right column.
  const grid = page.getByRole('region', { name: 'Tuiles' });
  await expect(grid.getByRole('article')).toHaveCount(3);
  const [l, a, b] = [await box(lead), await box(second), await box(third)];
  expect(a.x).toBeGreaterThanOrEqual(l.x + l.width - 1);
  expect(b.x).toBeCloseTo(a.x, 0);
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  expect(a.y).toBeCloseTo(l.y, 0);
  // The orchestrator spans both rows: the agents are stacked beside it, not under it.
  expect(l.height).toBeGreaterThan(a.height * 1.8);
  expect(l.width).toBeGreaterThan(a.width * 1.8);
});

// FR-021, FR-022: the terminal takes exactly the free area of the tile; the buttons of the state
// show on hover or focus and never cover the text.
test('fills its tile with the terminal: the last line shows, and no button covers it (T022a)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env: env('ask-permission') });
  const page = await launched.app.firstWindow();
  const [tile] = await launchAgents(launched, page, repo, 1);
  if (!tile) throw new Error('no tile');
  await typeIn(page, tile, 'Analyse');
  await expect(tile).toHaveAttribute('data-state', 'awaiting-answer');
  await expect(tile.locator('.xterm-rows')).toContainText('(allow/deny)');

  // xterm is opened in a container without any padding: its fit measures the free area.
  const padding = await tile.locator('.xterm').evaluate((xterm) => {
    const style = getComputedStyle(xterm.parentElement as HTMLElement);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  });
  expect(padding).toEqual(['0px', '0px', '0px', '0px']);

  // The rows fill the container: less than one row of slack under the screen (FR-021).
  const fit = await tile.locator('.xterm').evaluate((xterm) => {
    const parent = (xterm.parentElement as HTMLElement).getBoundingClientRect();
    const screen = (xterm.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
    const rows = xterm.querySelectorAll('.xterm-rows > div').length;
    return {
      slack: parent.bottom - screen.bottom,
      row: screen.height / rows,
      over: screen.bottom - parent.bottom,
    };
  });
  expect(fit.over).toBeLessThanOrEqual(0.5);
  expect(fit.slack).toBeLessThan(fit.row + 1);

  // The last line written by the CLI, with and without the pointer on the tile.
  const lastLine = () =>
    tile.locator('.xterm').evaluate((xterm) => {
      const rows = Array.from(xterm.querySelectorAll('.xterm-rows > div'));
      const row = rows.filter((r) => r.textContent.trim() !== '').at(-1);
      if (!row) return null;
      const range = document.createRange();
      range.selectNodeContents(row);
      const r = range.getBoundingClientRect();
      const frame = (xterm.parentElement as HTMLElement).getBoundingClientRect();
      return {
        text: row.textContent,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        frameBottom: frame.bottom,
      };
    });
  const buttons = () => tile.getByRole('button', { name: /Autoriser|Refuser/ });

  for (const pointer of ['away', 'over'] as const) {
    if (pointer === 'over') await tile.hover();
    else await page.mouse.move(2, 2);
    const line = await lastLine();
    expect(line?.text).toContain('(allow/deny)');
    expect(line?.bottom).toBeLessThanOrEqual((line?.frameBottom ?? 0) + 0.5);
    for (const button of await buttons().all()) {
      const b = await box(button);
      const apart =
        b.y >= (line?.bottom ?? 0) - 0.5 ||
        b.y + b.height <= (line?.top ?? 0) + 0.5 ||
        b.x >= (line?.right ?? 0) - 0.5 ||
        b.x + b.width <= (line?.left ?? 0) + 0.5;
      expect(apart, `a button covers the last line (${pointer})`).toBe(true);
    }
  }

  // Hidden without hover, shown on hover and on keyboard focus (FR-022); still due, so the
  // contour of the tile tells it (the tile does not rely on the buttons).
  // (Opacity is not inherited: the product of the opacities of the button and its ancestors.)
  const shown = () =>
    buttons()
      .first()
      .evaluate((el) => {
        let opacity = 1;
        for (let e: Element | null = el; e; e = e.parentElement) {
          opacity *= Number(getComputedStyle(e).opacity);
        }
        return opacity;
      });
  await page.mouse.move(2, 2);
  await expect.poll(shown).toBe(0);
  await tile.hover();
  await expect.poll(shown).toBe(1);
  await page.mouse.move(2, 2);
  await expect.poll(shown).toBe(0);
  await buttons().first().focus();
  await expect.poll(shown).toBe(1);
});
