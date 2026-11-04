import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, typeIn } from './helpers/workspace';

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
  // PACT commits the integrations itself: the repository needs an identity (none on CI runners).
  git(repo, 'config', 'user.name', 'PACT Test');
  git(repo, 'config', 'user.email', 'test@pact.dev');
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

// 003 T045 — the orchestrator reads and asks for an integration under the same paths (FR-023).
test('lets the orchestrator read and integrate a file with spaces and accents', async () => {
  test.setTimeout(120_000);
  const userDataDir = join(root, 'Données PACT');
  await mkdir(userDataDir);
  launched = await launchApp({
    userDataDir,
    env: { ...env, FAKE_CLI_SCENARIO: scenarioPath('orchestra-paths') },
  });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  const worker = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(worker).toHaveAttribute('data-state', 'awaiting-prompt');

  await lead.locator('.xterm').click();
  await page.keyboard.type('Écris la fonction');
  await page.keyboard.press('Enter');
  await expect(lead).toContainText('MCP get_file_diff :');
  await expect(lead).toContainText('+export const f = 1;');
  await expect(lead).toContainText('MCP request_integration :');

  const request = page
    .getByRole('complementary', { name: 'Agents' })
    .getByRole('listitem')
    .filter({ hasText: '◎ Intégrer Faux CLI 2 → main ?' });
  await request.getByRole('button', { name: '✓ Intégrer' }).click();
  await expect(lead).toContainText('intégration integrated');
  expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('feat: données à jour');
  expect(git(repo, '-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'main')).toBe(
    'src/données à jour.ts',
  );
});

// 004 T047 — the skills, a mockup and the recap under the same paths, app data included (FR-032).
test('hands its skills to the orchestrator and shows its recap and a mockup with spaces and accents', async () => {
  test.setTimeout(120_000);
  const userDataDir = join(root, 'Données PACT');
  await mkdir(userDataDir);
  launched = await launchApp({
    userDataDir,
    env: { ...env, FAKE_CLI_SCENARIO: scenarioPath('recap-writer') },
  });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');

  // Its skills were copied under « Données PACT », out of the user's configuration.
  const roles = join(userDataDir, 'roles');
  const copies = await Promise.all(
    (await readdir(roles)).map((id) =>
      readdir(join(roles, id, 'plugin', 'skills')).catch(() => []),
    ),
  );
  expect(copies.flat()).toContain('pact-orchestrator');

  await typeIn(page, lead, 'Tiens le recap');
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  const mockup = 'design/mockups/écran d’accueil.html';
  await mkdir(join(agentWorktree(repo, 1), 'design', 'mockups'), { recursive: true });
  await writeFile(
    join(agentWorktree(repo, 1), mockup),
    '<!doctype html><html><head><meta charset="utf-8"><title>Accueil</title></head><body><h1>Écran d’accueil</h1></body></html>',
  );

  await lead.getByRole('button', { name: 'Agrandir' }).click();
  await page.getByRole('tab', { name: 'Aperçu' }).click();
  const files = page.getByRole('list', { name: 'Fichiers de l’Aperçu' });
  const recap = page.frameLocator('iframe[title="Aperçu : .pact/recap.md"]');
  await expect(recap.getByRole('heading', { level: 1 })).toHaveText('Recap — 3 novembre');
  await files.getByRole('button', { name: new RegExp(mockup) }).click();
  const shown = page.frameLocator(`iframe[title="Aperçu : ${mockup}"]`);
  await expect(shown.getByRole('heading')).toHaveText('Écran d’accueil');
});
