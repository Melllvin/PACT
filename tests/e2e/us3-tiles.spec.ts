import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US3 end to end with the fake CLI: 2×2 then 3×2, answering from a tile, a crash then
// « Reprendre », and the free terminal at the root of the main repository (T073).
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
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us3-')));
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

test('drives agents from their tiles', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  // 4 agents: 2×2 (US3 scenario 1).
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  let launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 4);
  await launcher.getByRole('button', { name: 'Lancer 4 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const grid = page.getByRole('region', { name: 'Tuiles' });
  await expect(grid).toHaveAttribute('data-layout', '2x2');
  await expect(page.getByRole('article', { name: /^Faux CLI \d/ })).toHaveCount(4);
  const colors = await page
    .getByRole('article', { name: /^Faux CLI \d/ })
    .evaluateAll((tiles) =>
      tiles.map((t) => (t as HTMLElement).style.getPropertyValue('--agent-color')),
    );

  // The 2×2 is full: 2 more agents and a free terminal from « + Agents » give 3×2, same colors.
  await expect(page.getByRole('button', { name: 'Ajouter un agent' })).toHaveCount(0);
  await page.getByRole('button', { name: '+ Agents' }).click();
  launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 2);
  await setCount(launcher.getByRole('group', { name: 'Terminal libre' }), 1);
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await expect(grid).toHaveAttribute('data-layout', '3x2');
  await expect(page.getByRole('article', { name: /^Faux CLI \d/ })).toHaveCount(6);
  const after = await page
    .getByRole('article', { name: /^Faux CLI \d/ })
    .evaluateAll((tiles) =>
      tiles.map((t) => (t as HTMLElement).style.getPropertyValue('--agent-color')),
    );
  expect(after.slice(0, 4)).toEqual(colors);

  // ⎇ shows the branch and the port (scenario 3).
  const first = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await first.getByRole('button', { name: 'Branche et port' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('agent/fake-1 · :3001');

  // A prompt typed in the tile reaches the CLI, which asks; « Autoriser » answers (scenario 5).
  await expect(first).toHaveAttribute('data-state', 'awaiting-prompt');
  await typeIn(page, first, 'Supprime le fichier');
  await first.getByRole('button', { name: '✓ Autoriser' }).click();
  await expect(first).toContainText('Autorisé');

  // Then it crashes: red halo, raw output kept, « Reprendre » resumes the session (scenario 6).
  await expect(first).toHaveAttribute('data-state', 'error');
  await expect(first).toHaveClass(/halo/);
  await expect(first).toContainText('Analyse du dépôt');
  await expect(first).toContainText('code 1');
  await first.getByRole('button', { name: 'Reprendre' }).click();
  await expect(first).toContainText('Session reprise');
  await expect(first).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(first).not.toHaveClass(/halo/);

  // The free terminal runs at the root of the main repository, on main (scenario 7).
  const shell = page.getByRole('article', { name: 'Terminal libre' });
  await typeIn(page, shell, 'git status --porcelain=v2 --branch');
  await expect(shell).toContainText('# branch.head main', { timeout: 20_000 });
});
