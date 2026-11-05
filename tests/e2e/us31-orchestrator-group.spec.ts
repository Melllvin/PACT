import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 006 US4 end to end (T035): the orchestrator launches two agents, one of them works (it asks for a
// permission) and the other waits; closing the orchestrator closes the three, worktrees kept; the
// restart with « Reprendre le travail » brings the three back and only the agent that worked
// receives the resume prompt. The tile of a closed agent stays, with « Relancer » (the restart
// goes through a dialog named after the orchestrator, FR-025, FR-026).

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-group'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us31-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('closes then restarts an orchestrator with its two agents, resuming the one that worked', async () => {
  test.setTimeout(150_000);
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
  const worker = page.getByRole('article', { name: /^Faux CLI 2,/ });
  const idle = page.getByRole('article', { name: /^Faux CLI 3,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');

  await typeIn(page, lead, 'feat/un|feat/deux');
  await expect(worker).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(idle).toHaveAttribute('data-state', 'awaiting-prompt');
  // The worker is at work (it waits for an answer); the other one waits for a prompt.
  await typeIn(page, worker, 'DEMANDE');
  await expect(worker).toHaveAttribute('data-state', 'awaiting-answer');

  // Closing the orchestrator: its dialog lists the two agents; the worktrees are kept by default.
  await lead.getByRole('button', { name: 'Fermer l’agent' }).click();
  const closing = page.getByRole('dialog', { name: 'Fermer Faux CLI 1' });
  await expect(closing.getByRole('listitem')).toHaveCount(2);
  await expect(closing).toContainText('Faux CLI 2');
  await expect(closing).toContainText('Faux CLI 3');
  await expect(closing.getByRole('radio', { name: /Conserver/ })).toBeChecked();
  await closing.getByRole('button', { name: 'Fermer l’agent' }).click();
  for (const tile of [lead, worker, idle]) {
    await expect(tile).toHaveAttribute('data-state', 'closed');
  }

  // Restart: « Reprendre le travail » is checked by default.
  await lead.getByRole('button', { name: 'Relancer' }).click();
  const restarting = page.getByRole('dialog', { name: 'Relancer Faux CLI 1' });
  await expect(restarting.getByRole('checkbox', { name: /Reprendre le travail/ })).toBeChecked();
  await restarting.getByRole('button', { name: 'Relancer' }).click();

  for (const tile of [lead, idle]) {
    await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  }
  // Only the agent that worked receives the resume prompt: it prints what it received, anew.
  await expect(worker).toContainText(/Reçu : (?!DEMANDE)/);
  await expect(idle).not.toContainText('Reçu :');
  await expect(lead).not.toContainText(/Reçu : (?!feat\/un)/);
});

test('closing an agent that is not the orchestrator closes only that agent', async () => {
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
  const worker = page.getByRole('article', { name: /^Faux CLI 2,/ });
  const idle = page.getByRole('article', { name: /^Faux CLI 3,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  await typeIn(page, lead, 'feat/un|feat/deux');
  await expect(worker).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(idle).toHaveAttribute('data-state', 'awaiting-prompt');

  await worker.getByRole('button', { name: 'Fermer l’agent' }).click();
  const closing = page.getByRole('dialog', { name: 'Fermer Faux CLI 2' });
  await expect(closing.getByRole('listitem')).toHaveCount(0);
  await closing.getByRole('button', { name: 'Fermer l’agent' }).click();
  await expect(worker).toHaveCount(0);
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  await expect(idle).toHaveAttribute('data-state', 'awaiting-prompt');
});
