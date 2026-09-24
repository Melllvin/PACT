import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US2 end to end with the fake CLI: quick launch, first-launch permissions, restart (T057).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const env = { PACT_FAKE_CLI: FAKE_CLI, FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done') };

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us2-')));
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

test('launches 2 fake agents and a free terminal, then restores them after a restart', async () => {
  test.setTimeout(90_000);
  launched = await launchApp({ env });
  let page = await launched.app.firstWindow();

  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();

  // 1c: one fake agent is preselected; ask for two and a free terminal.
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher
    .getByRole('group', { name: 'Terminal libre' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();

  // 1m on the very first launch: Enter keeps « Toujours autoriser ».
  await expect(page.getByRole('dialog', { name: 'Autorisations des agents' })).toBeVisible();
  await page.keyboard.press('Enter');

  const first = page.getByRole('article', { name: 'Faux CLI 1' });
  const second = page.getByRole('article', { name: 'Faux CLI 2' });
  await expect(first).toContainText(':3001');
  await expect(second).toContainText(':3002');
  await expect(first).toContainText('agent/fake-1');
  await expect(page.getByRole('article', { name: 'Terminal libre' })).toBeVisible();
  // The fake CLI printed its banner in the agent terminal: it waits for a prompt (FR-018).
  await expect(first).toContainText('Session');

  const worktrees = git(repo, 'worktree', 'list');
  expect(worktrees).toContain('[agent/fake-1]');
  expect(worktrees).toContain('[agent/fake-2]');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(repo, 'branch', '--show-current')).toBe('main');

  const saved = async () => {
    const files = join(launched?.userDataDir ?? '', 'workspaces');
    const [file] = execFileSync('ls', [files], { encoding: 'utf8' }).trim().split('\n');
    const json = JSON.parse(await readFile(join(files, file ?? ''), 'utf8')) as {
      data: { agents: { color: string; branch: string; port: number }[] };
    };
    return json.data.agents.map(({ color, branch, port }) => ({ color, branch, port }));
  };
  const before = await saved();
  expect(before).toEqual([
    { color: 'purple', branch: 'agent/fake-1', port: 3001 },
    { color: 'cyan', branch: 'agent/fake-2', port: 3002 },
  ]);

  // Restart: the agents come back with the same colors, branches and ports, to be resumed.
  const userDataDir = launched.userDataDir;
  await launched.close({ keepData: true });
  launched = await launchApp({ userDataDir, env });
  page = await launched.app.firstWindow();
  await expect(page.getByRole('article', { name: 'Faux CLI 1' })).toContainText(':3001');
  await expect(page.getByRole('article', { name: 'Faux CLI 2' })).toContainText(':3002');
  await expect(page.getByRole('article', { name: 'Faux CLI 1' })).toContainText('✕');
  expect(await saved()).toEqual(before);
});
