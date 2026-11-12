import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 005 US1 end to end (T013): the fake CLI reports its limits through the statusLine PACT hands
// it, and the gauge of the workspace bar follows; without limits, no gauge.
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
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us24-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const makeRepo = async () => {
  const repo = join(root, 'atelier');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};

/** Sets a counter of the quick launcher (1c) to `target`. */
const setCount = async (group: Locator, target: number) => {
  const count = group.getByRole('status');
  for (;;) {
    const value = Number(await count.textContent());
    if (value === target) return;
    await group
      .getByRole('button', { name: value < target ? /^Ajouter un / : /^Retirer un / })
      .click();
  }
};

/** Opens the repo and launches one fake agent, `Toujours autoriser`. */
const launchOne = async (scenario: string): Promise<{ page: Page; tile: Locator }> => {
  const repo = await makeRepo();
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath(scenario),
    },
  });
  const { app } = launched;
  const page = await app.firstWindow();
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 1);
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter');
  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  return { page, tile };
};

const typeIn = async (page: Page, tile: Locator, text: string) => {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('shows the limits the CLI reports, and follows them', async () => {
  test.setTimeout(90_000);
  const { page, tile } = await launchOne('usage-update');
  const gauges = page.getByRole('group', { name: 'Limites d’usage' });
  await expect(gauges).toHaveCount(0);

  await typeIn(page, tile, 'Travaille');
  // The terminal shows PACT's line, as Claude Code would at the foot of its screen.
  await expect(tile).toContainText('Statut : PACT · 5 h 62 %');
  const gauge = gauges.getByRole('button', { name: /Faux CLI 62 % · 5 h/ });
  await expect(gauge).toBeVisible();
  const meter = gauges.getByRole('meter', { name: 'Limite d’usage Faux CLI' });
  await expect(meter).toHaveAttribute('data-level', 'ok');

  await gauge.hover();
  const detail = page.getByRole('region', { name: 'Détail de l’usage Faux CLI' });
  await expect(detail).toContainText('5 h : 62 %');
  await expect(detail).toContainText('semaine : 18 %');

  await typeIn(page, tile, 'Continue');
  await expect(gauges.getByRole('button', { name: /Faux CLI 85 % · 5 h/ })).toBeVisible();
  await expect(meter).toHaveAttribute('data-level', 'warn');
  await expect(meter).toHaveAttribute(
    'aria-valuetext',
    '85 % de la fenêtre 5 h, proche de la limite',
  );
});

test('shows no gauge when the CLI reports no limits', async () => {
  test.setTimeout(90_000);
  const { page, tile } = await launchOne('usage-apikey');
  await typeIn(page, tile, 'Travaille');
  await expect(tile).toContainText('Statut : PACT');
  await expect(tile).toHaveAttribute('data-state', 'done');
  await expect(page.getByRole('group', { name: 'Limites d’usage' })).toHaveCount(0);
});
