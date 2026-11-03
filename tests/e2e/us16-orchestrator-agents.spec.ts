import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 003 US4 end to end (T038): the orchestrator launches an agent with its first prompt, then
// closes it; the tile goes, the worktree and the branch stay (FR-015, FR-016).

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-agents'),
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us16-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('launches an agent for the orchestrator, then closes it and keeps its worktree', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');

  await typeIn(page, lead, 'feat/lancé|Écris la fonction');
  const worker = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(worker).toBeVisible();
  await expect(worker).toContainText('Écris la fonction');
  await expect(lead).toContainText('MCP close_agent :');

  await expect(worker).toHaveCount(0);
  expect(git(repo, 'branch', '--list', 'feat/lancé')).toContain('feat/lancé');
  expect(git(repo, 'worktree', 'list')).toContain('[feat/lancé]');
});
