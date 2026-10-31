import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 003 US2 end to end (T027): the orchestrator sends a prompt, waits for the end of the agent's
// turn, then reads the files it changed.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-follow'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us14-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('waits for the end of an agent’s turn, then reads its changes', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  // The first launch already counts one agent of the first CLI.
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

  await typeIn(page, lead, 'Faux CLI 2|Écris la fonction');
  await expect(worker).toContainText('Reçu : Écris la fonction');
  await expect(lead).toContainText('MCP wait_for_agents : Faux CLI 2 a fini son tour');
  await expect(lead).toContainText('MCP get_changes :');
  await expect(lead).toContainText('src/fonction.ts');
});
