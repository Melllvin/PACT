import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 003 US3 end to end (T033): the orchestrator asks for an integration, main stays as it is
// until the user confirms it in À faire, then the commit lands and the orchestrator hears of it.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-integrate'),
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us15-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('integrates what the orchestrator asks for once the user confirms it', async () => {
  test.setTimeout(150_000);
  const mainBefore = git(repo, 'rev-parse', 'main');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: /^Ajouter un / })
    .click();
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  const worker = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(worker).toHaveAttribute('data-state', 'awaiting-prompt');

  await typeIn(page, lead, 'Faux CLI 2|Écris la fonction');
  await expect(lead).toContainText('MCP request_integration :', { timeout: 20_000 });
  const column = page.getByRole('complementary', { name: 'Agents' });
  const request = column
    .getByRole('listitem')
    .filter({ hasText: '◎ Intégrer Faux CLI 2 → main ?' });
  await expect(request).toBeVisible();
  // FR-017: nothing is integrated before the user says so.
  expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);

  const message = request.getByRole('textbox', { name: 'Message de commit' });
  await expect(message).toHaveValue('feat: la fonction');
  await message.fill('feat: la fonction, relue');
  await request.getByRole('button', { name: '✓ Intégrer' }).click();

  await expect(request).toHaveCount(0);
  await expect(lead).toContainText('intégration integrated');
  expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('feat: la fonction, relue');
  expect(git(repo, 'show', '--name-only', '--format=', 'main')).toContain('src/fonction.ts');
  // R6: the tile of the agent is closed once integrated.
  await expect(worker).toHaveCount(0);
});
