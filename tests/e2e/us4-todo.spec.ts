import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US4 end to end with the fake CLI: the À faire column sorted, answering from it, and the
// ◆ then ✕ on the tab of a workspace left in the background (T083).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

// Each agent asks for a permission on its first prompt, then crashes once answered.
const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('ask-then-crash'),
};

let root: string;
let launched: LaunchedApp | undefined;

const makeRepo = async (name: string) => {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us4-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Sets a counter of the quick launcher (1c) to `target`. */
const setCount = async (group: Locator, target: number) => {
  const count = group.getByRole('status');
  for (;;) {
    const value = Number(await count.textContent());
    if (value === target) return;
    await group.getByRole('button', { name: value < target ? '+' : '−' }).click();
  }
};

/** Types in the terminal of a tile, as the user would after clicking into it. */
const typeIn = async (page: Page, tile: Locator, text: string) => {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('handles the requests of the agents from the À faire column', async () => {
  test.setTimeout(120_000);
  const first = await makeRepo('atelier');
  const second = await makeRepo('facturation');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, first, second);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 3);
  await launcher.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  for (const n of [1, 2, 3]) await expect(tile(n)).toHaveAttribute('data-state', 'awaiting-prompt');

  // Two agents ask: two « ◆ Répondre » before the « Donner une consigne » (US4 scenario 1).
  await typeIn(page, tile(1), 'Supprime le fichier');
  await typeIn(page, tile(2), 'Supprime le fichier');
  const column = page.getByRole('complementary', { name: 'À faire' });
  const items = column.getByRole('listitem');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('◆ Répondre');
  await expect(items.nth(1)).toContainText('◆ Répondre');
  await expect(items.nth(2)).toHaveText('Donner une consigne · Faux CLI · tapez dans le terminal');
  await expect(page.getByRole('button', { name: /À faire/ })).toContainText('3');

  // Answered from the column: gone from the tile too, in under a second (scenario 2).
  await items.nth(0).getByRole('button', { name: '✓ Autoriser' }).click();
  await expect(tile(1).getByRole('button', { name: '✓ Autoriser' })).toHaveCount(0, {
    timeout: 1_000,
  });
  await expect(column.getByRole('button', { name: '✓ Autoriser' })).toHaveCount(1);

  // Another workspace in front: ◆ on the tab of the first, where agent 2 still waits (scenario 3).
  await page.getByRole('button', { name: 'Nouvel onglet' }).click();
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('tab', { name: 'facturation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('img', { name: 'atelier : un agent attend une réponse' })).toHaveText(
    '◆',
  );

  // Once answered, agent 2 crashes like agent 1: ✕ on the tab (scenario 4).
  await page.getByRole('tab', { name: 'atelier' }).click();
  await column.getByRole('button', { name: '✓ Autoriser' }).click();
  await expect(tile(2)).toHaveAttribute('data-state', 'error');
  await page.getByRole('tab', { name: 'facturation' }).click();
  await expect(page.getByRole('img', { name: 'atelier : un agent est en erreur' })).toHaveText('✕');
});
