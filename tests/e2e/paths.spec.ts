import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// T113 — a repository and app data under paths with spaces and accents, on macOS and Windows.
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
  FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-paths-')));
  repo = join(root, 'Mes Projets', 'Développement');
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

test('runs an agent and a free terminal in « Mes Projets/Développement »', async () => {
  test.setTimeout(90_000);
  const userDataDir = join(root, 'Données PACT');
  await mkdir(userDataDir);
  launched = await launchApp({ userDataDir, env });
  const page = await launched.app.firstWindow();

  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('tab', { name: 'Développement' })).toBeVisible();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();

  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Terminal libre' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await expect(page.getByRole('dialog', { name: 'Autorisations des agents' })).toBeVisible();
  await page.keyboard.press('Enter');

  // The fake CLI started in its worktree under the accented path and waits for a prompt.
  const agent = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(agent).toContainText('Session');
  const worktrees = git(repo, 'worktree', 'list', '--porcelain');
  expect(worktrees.normalize('NFC')).toContain('Mes Projets');
  expect(worktrees).toContain('branch refs/heads/agent/fake-1');
  expect(git(repo, 'status', '--porcelain')).toBe('');

  // The free terminal opens at the root of the repository, spaces and accents included.
  const terminal = page.getByRole('article', { name: 'Terminal libre' });
  await terminal.locator('.xterm').click();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText(/Mes Projets[\\/]Développement/, { timeout: 15_000 });
});
