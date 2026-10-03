import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 002 US1 end to end (T019): the fake CLI writes, deletes, renames and commits in its worktree,
// then « Revue → » shows the list, the totals, the diff and « vu », and follows a new write.
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
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us8-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
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

const typeIn = async (page: Page, tile: Locator, text: string) => {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

/** The worktree of the only agent, from git itself. */
const agentWorktree = () =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .find((path) => path !== repo) ?? '';

test('reviews the changes of an agent and follows its worktree', async () => {
  test.setTimeout(120_000);
  const mainBefore = git(repo, 'rev-parse', 'main');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 1);
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »

  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(tile.getByRole('button', { name: 'Revue →' })).toHaveCount(0);
  await typeIn(page, tile, 'Modifie les fichiers');
  await expect(tile).toHaveAttribute('data-state', 'done');

  // « Revue → » on the tile and in À faire (FR-002).
  const todo = page.getByRole('complementary', { name: 'À faire' });
  await expect(todo.getByRole('button', { name: 'Revue →' })).toBeVisible();
  await tile.getByRole('button', { name: 'Revue →' }).click();

  // Screen 1h: the Changements tab, the Décision column in place of À faire (FR-004).
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await expect(focus.getByRole('tab', { name: 'Changements' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const decision = page.getByRole('complementary', { name: 'Décision' });
  await expect(decision).toBeVisible();
  await expect(todo).toHaveCount(0);

  // Each file once, committed or not, and the totals as their sum (scenario 1).
  const summary = focus.getByRole('group', { name: 'Résumé des changements' });
  await expect(summary.getByRole('heading')).toHaveText('Changements · 4');
  await expect(summary).toContainText('⎇ agent/fake-1');
  await expect(summary).toContainText('+2 −1 · 0 / 4 vus');
  const files = focus.getByRole('list', { name: 'Fichiers' }).getByRole('listitem');
  await expect(files).toHaveText([
    /gone\.txt.*supprimé|supprimé.*gone\.txt/,
    /new\.txt/,
    /notes\.md/,
    /src\/Développement é\.ts/,
  ]);
  await expect(files.nth(1)).toContainText('renommé');
  await expect(files.nth(1)).toContainText('old.txt');

  // The diff of the file chosen, its lines numbered (scenario 2).
  await files.nth(2).getByRole('button').click();
  const diff = focus.getByRole('table', { name: 'Diff de notes.md' });
  await expect(diff.getByRole('row').filter({ hasText: 'à relire' })).toHaveAttribute(
    'data-kind',
    'add',
  );

  // « vu » counts, and stays while the file does not change (scenario 3).
  await focus.getByRole('checkbox', { name: 'Vu : notes.md' }).click();
  await expect(summary).toContainText('1 / 4 vus');
  await expect(decision).toContainText('3 fichiers non vus');

  // The agent's terminal stays under the changes, with the same session.
  await expect(focus.getByLabel('Terminal de Faux CLI 1')).toContainText(
    'Modification des fichiers',
  );

  // A new write: the seen file is unseen again, announced in under 3 s (scenario 4, SC-006).
  await writeFile(join(agentWorktree(), 'notes.md'), 'à relire\nencore\n');
  await expect(
    focus.getByRole('status').filter({ hasText: 'Nouveaux changements : +1 −0 · revoir' }),
  ).toBeVisible({ timeout: 3000 });
  await expect(summary).toContainText('0 / 4 vus');
  await expect(focus.getByRole('checkbox', { name: 'Vu : notes.md' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(diff.getByRole('row').filter({ hasText: 'encore' })).toBeVisible();

  // Back to the tiles: À faire again (scenario 7).
  await focus.getByRole('button', { name: '‹ Tuiles' }).click();
  await expect(page.getByRole('region', { name: 'Tuiles' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'À faire' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Décision' })).toHaveCount(0);
  // Nothing reached main.
  expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
});
