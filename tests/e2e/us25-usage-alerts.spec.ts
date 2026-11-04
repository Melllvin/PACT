import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 005 US2 end to end (T022): near a limit the gauge turns orange then red, À faire tells it once,
// and the launcher warns before more agents of that CLI start, without stopping them.
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
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us25-')));
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
    await group.getByRole('button', { name: value < target ? '+' : '−' }).click();
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

test('alerts near the limit, once, and warns before a launch', async () => {
  test.setTimeout(120_000);
  const { page, tile } = await launchOne('usage-alerts');
  const gauges = page.getByRole('group', { name: 'Limites d’usage' });
  const meter = gauges.getByRole('meter', { name: 'Limite d’usage Faux CLI' });
  const todos = page.getByRole('complementary', { name: 'À faire' });
  const alerts = todos.getByRole('listitem').filter({ hasText: /Limite Faux CLI à/ });

  await typeIn(page, tile, 'Travaille');
  await expect(meter).toHaveAttribute('data-level', 'warn');
  await expect(alerts).toHaveCount(1);
  await expect(alerts).toContainText('Limite Faux CLI à 80 % · 5 h');

  await typeIn(page, tile, 'Continue');
  await expect(meter).toHaveAttribute('data-level', 'critical');
  await expect(alerts).toContainText('Limite Faux CLI à 95 % · 5 h');
  await expect(alerts).toHaveCount(1);

  await page.getByRole('button', { name: '+ Agents' }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 1);
  await expect(launcher.getByRole('note', { name: 'Limite d’usage Faux CLI' })).toContainText(
    'Limite 5 h à 95 %',
  );
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await expect(page.getByRole('article', { name: /^Faux CLI 2,/ })).toBeVisible();
});
