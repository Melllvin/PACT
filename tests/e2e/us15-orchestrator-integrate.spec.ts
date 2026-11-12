import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, typeIn } from './helpers/workspace';

// 003 US3 end to end (T033), migrated by 008 T023: `request_integration` is gone. The orchestrator's
// `request_delivery` is refused without a loop; the user asks to merge without a verdict, main stays
// as it is until they confirm it in À faire, then the commit lands (local channel, no remote).

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

test('merges what the user asks for once they confirm it, and refuses a delivery without a loop', async () => {
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
  await expect(lead).toContainText('MCP request_delivery :', { timeout: 20_000 });
  await expect(lead).toContainText('Aucune boucle', { timeout: 20_000 });
  await expect(worker).not.toHaveAttribute('data-state', 'working');

  // The agent commits (the delivery refuses uncommitted changes); the user asks to merge, no verdict.
  const tree = agentWorktree(repo, 2);
  git(tree, 'add', '-A');
  git(tree, 'commit', '-m', 'feat: la fonction');
  await worker.getByRole('button', { name: 'Fusionner sans verdict' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();

  const column = page.getByRole('complementary', { name: 'Agents' });
  const request = column
    .getByRole('listitem')
    .filter({ hasText: '◎ Fusionner Faux CLI 2 → main ?' });
  await expect(request).toBeVisible();
  await expect(request).toContainText('sans verdict');
  // FR-017: nothing is integrated before the user says so.
  expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);

  await request.getByRole('button', { name: 'Fusionner' }).click();

  await expect(request).toHaveCount(0);
  // The merge runs after the click (« merging »): main moves a moment later.
  await expect
    .poll(() => git(repo, 'show', '--name-only', '--format=', 'main'), { timeout: 30_000 })
    .toContain('src/fonction.ts');
  // R6: the tile of the agent is closed once integrated.
  await expect(worker).toHaveCount(0);
});
