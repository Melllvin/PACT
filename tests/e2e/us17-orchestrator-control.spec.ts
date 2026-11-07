import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 003 US5 end to end (T042): the user reads what the orchestrator did in « ◎ Actions », withdraws
// its role, and PACT refuses its next request (FR-004, FR-021).

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-control'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us17-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('shows the orchestrator’s actions, withdraws its role, then refuses its requests', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
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

  await typeIn(page, lead, 'Faux CLI 2|Écris la fonction');
  await expect(worker).toContainText('Écris la fonction', { timeout: 20_000 });

  await lead.getByRole('button', { name: 'Agrandir' }).click();
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await focus.getByRole('tab', { name: '◎ Actions' }).click();
  const journal = focus.getByRole('list', { name: 'Actions de l’orchestrateur' });
  await expect(journal).toContainText('send_prompt');
  await expect(journal).toContainText('Faux CLI 2');

  await focus.getByRole('button', { name: 'Retirer le rôle d’orchestrateur' }).click();
  await focus.getByRole('button', { name: 'Retirer', exact: true }).click();
  await expect(focus.getByRole('tab', { name: '◎ Actions' })).toHaveCount(0);
  await expect(focus.getByRole('tab', { name: 'Terminal', selected: true })).toBeVisible();
  await page.getByRole('button', { name: '‹ Tuiles' }).click();

  // The agent stays open; PACT no longer answers its tools.
  await typeIn(page, lead, 'Faux CLI 2|Encore');
  await expect(lead).toContainText('MCP send_prompt : HTTP 401');
  await expect(worker).not.toContainText('Encore');
});
