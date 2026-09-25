import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US5 end to end with the fake CLI: ⤢ opens the Focus, typing there, « Toujours pour ce
// worktree », a pill to another agent with its whole history, Escape back to the grid (T089).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

// Each agent asks for the same permission on every prompt.
const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('ask-permission'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us5-')));
  repo = join(root, 'Développement');
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

test('works with one agent in Focus, then comes back to the grid', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 2);
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »

  // The second agent asks while the first one is in Focus.
  const second = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(second).toHaveAttribute('data-state', 'awaiting-prompt');
  await typeIn(page, second, 'Deux');
  await expect(second).toContainText('? Exécuter : rm fichier.txt');

  // ⤢: the tile takes the main area, with its branch and port (scenario 1).
  const first = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(first).toHaveAttribute('data-state', 'awaiting-prompt');
  await first.getByRole('button', { name: 'Agrandir' }).click();
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await expect(focus).toContainText('agent/fake-1 · :3001');
  await expect(page.getByRole('region', { name: 'Tuiles' })).toHaveCount(0);

  // Typing in the Focus terminal; « Toujours pour ce worktree » then allows the next same
  // request without asking (scenario 4).
  await typeIn(page, focus, 'Un');
  await focus.getByRole('button', { name: 'Toujours pour ce worktree' }).click();
  await expect(focus).toContainText('Autorisé');
  await expect(focus).toHaveAttribute('data-state', 'done');
  await typeIn(page, focus, 'Encore');
  await expect(focus.getByText('Autorisé')).toHaveCount(2);
  await expect(focus).toHaveAttribute('data-state', 'done');

  // Escape typed in the terminal belongs to the CLI: the Focus stays.
  await focus.locator('.xterm').click();
  await page.keyboard.press('Escape');
  await expect(focus).toBeVisible();

  // A pill shows another agent, with its whole history (scenario 2).
  await page.getByRole('radio', { name: 'Faux CLI 2, attend votre réponse' }).click();
  const other = page.getByRole('region', { name: 'Focus : Faux CLI 2' });
  await expect(other).toContainText('Analyse du dépôt');
  await expect(other).toContainText('? Exécuter : rm fichier.txt');

  // Escape outside the terminal: back to the grid, every output intact (scenario 3).
  await other.getByRole('button', { name: '‹ Tuiles' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Tuiles' })).toBeVisible();
  await expect(first.getByText('Autorisé')).toHaveCount(2);
  await expect(second).toContainText('? Exécuter : rm fichier.txt');
  await expect(second).toHaveAttribute('data-state', 'awaiting-answer');
});
