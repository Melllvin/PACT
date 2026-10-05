import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 002 US2 end to end (T030): the fake CLI changes its worktree, then « ✓ Intégrer » squashes it
// into one commit on main, closes the tile and removes the worktree; a refusing `pre-commit`
// hook leaves main as it was and shows git's message.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('edit-files'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us9-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  // PACT commits as the user: the identity comes from the repository, not from the test's env.
  git(repo, 'config', 'user.name', 'PACT Test');
  git(repo, 'config', 'user.email', 'test@pact.dev');
  await writeFile(join(repo, 'README.md'), '# test\n');
  await writeFile(join(repo, 'old.txt'), 'à déplacer\nsur plusieurs\nlignes\n');
  await writeFile(join(repo, 'gone.txt'), 'supprimé\n');
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

/** Launches one fake agent, has it change its worktree and opens its review (screen 1h). */
const reviewOneAgent = async ({ app }: LaunchedApp, page: Page) => {
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 1);
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »

  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  await tile.locator('.xterm').click();
  await page.keyboard.type('Modifie les fichiers');
  await page.keyboard.press('Enter');
  await expect(tile).toHaveAttribute('data-state', 'done');
  await tile.getByRole('button', { name: 'Revue →' }).click();
  return { tile, decision: page.getByRole('complementary', { name: 'Décision' }) };
};

test('integrates an agent into main in one commit, then closes its tile and worktree', async () => {
  test.setTimeout(120_000);
  const mainBefore = git(repo, 'rev-parse', 'main');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { tile, decision } = await reviewOneAgent(launched, page);

  // What to know before integrating (FR-016): no test command in this repository.
  await expect(decision).toContainText('Tests : non configurés');
  await expect(decision).toContainText('Aucun conflit avec main');
  await expect(decision).toContainText('4 fichiers non vus');
  await expect(decision.getByRole('button', { name: 'Squash en 1 commit ▾' })).toBeVisible();
  await expect(decision.getByRole('textbox', { name: 'Message du commit' })).toHaveValue(
    'Intègre agent/fake-1',
  );
  await decision.getByRole('textbox', { name: 'Message du commit' }).fill('Ajoute les fichiers');
  await decision.getByRole('button', { name: '✓ Intégrer' }).click();

  // Back to the tiles, with the notice, and the tile closed (US2/AC3, AC6).
  await expect(page.getByRole('status').filter({ hasText: '✓ Intégré' })).toHaveText(
    '✓ Intégré · agent/fake-1 → main',
  );
  await expect(tile).toHaveCount(0);

  // One commit on main with everything, committed or not (US2/AC1), in the folder too (FR-022).
  expect(git(repo, 'rev-list', '--count', `${mainBefore}..main`)).toBe('1');
  expect(git(repo, 'log', '-1', '--format=%s%n%P', 'main')).toBe(
    `Ajoute les fichiers\n${mainBefore}`,
  );
  expect(
    git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'main')
      .split('\n')
      .sort(),
  ).toEqual(['README.md', 'new.txt', 'notes.md', 'src/Développement é.ts']);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  // The worktree and the branch of the agent are gone (FR-024).
  await expect
    .poll(() => git(repo, 'worktree', 'list', '--porcelain').includes('/.worktrees/'))
    .toBe(false);
  expect(git(repo, 'branch', '--list', 'agent/fake-1')).toBe('');
});

test('leaves main as it was when a pre-commit hook refuses, and shows why', async () => {
  test.setTimeout(120_000);
  const mainBefore = git(repo, 'rev-parse', 'main');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const { decision } = await reviewOneAgent(launched, page);
  // Installed once the agent is done: its own commit in the worktree would hit it too.
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "lint en échec" >&2\nexit 1\n');
  await chmod(hook, 0o755);

  await decision.getByRole('button', { name: '✓ Intégrer' }).click();
  await expect(decision.getByRole('alert')).toContainText('lint en échec');
  // FR-023: nothing moved, and the review stays open on the agent.
  expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  await expect(decision.getByRole('button', { name: '✓ Intégrer' })).toBeEnabled();
});
