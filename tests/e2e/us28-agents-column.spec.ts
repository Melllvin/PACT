import { rm } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 006 US1 end to end (T014): the orchestrator launches three agents → four rows with their roles;
// an agent asks → its row comes first with « ◆ Répondre », the others have no action button; a
// click on a row opens the Focus; a merge asked for shows in « À traiter ».

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-three-agents'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us28-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const actionButtons = (row: Locator) =>
  row.getByRole('button').filter({ hasNotText: /^Faux CLI \d/ });

test('lists every agent of the orchestrator, puts the one that asks first, opens it on click', async () => {
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

  await typeIn(page, lead, 'feat/un|feat/deux|feat/trois|Écris la fonction');
  const column = page.getByRole('complementary', { name: 'Agents' });
  const rows = column.getByRole('list', { name: 'Agents du workspace' }).getByRole('listitem');

  // Three agents launched: four rows, each with its name and role (scenario 1).
  await expect(rows).toHaveCount(4);
  await expect(column.getByRole('heading', { level: 2, name: /^Agents 4/ })).toBeVisible();
  await expect(column.getByRole('button', { name: /^Faux CLI 1, orchestrateur, /i })).toBeVisible();
  for (const n of [2, 3, 4]) {
    await expect(
      column.getByRole('button', { name: new RegExp(`^Faux CLI ${String(n)}, `) }),
    ).toBeVisible();
  }

  // 008: the orchestrator cannot request a delivery without a loop (the scenario is refused); the user
  // asks to merge agent 4 without a verdict, and the request is in « À traiter » (scenario 4).
  const tile4 = page.getByRole('article', { name: /^Faux CLI 4,/ });
  await tile4.getByRole('button', { name: 'Fusionner sans verdict' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmer' }).click();
  const head = column.getByRole('list', { name: 'À traiter' });
  await expect(
    head.getByRole('listitem').filter({ hasText: '◎ Fusionner Faux CLI 4 → main ?' }),
  ).toBeVisible();
  await expect(head.getByRole('button', { name: 'Fusionner' })).toBeVisible();

  // Agent 3 asks a question: its row comes first with « ◆ Répondre » (scenario 2).
  const tile3 = page.getByRole('article', { name: /^Faux CLI 3,/ });
  // Since 007 the prompt of the orchestrator reaches each agent as an instruction of the journal,
  // read after a wake pointer (5 s grouping). « awaiting-prompt » is then the state BEFORE that first
  // turn: typing now would mix the user's line with the pointer PACT types at the same moment (seen on
  // Windows). The first turn of the three agents must be over.
  for (const n of [2, 3, 4]) {
    await expect(
      page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) }),
    ).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  }
  await typeIn(page, tile3, 'DEMANDE');
  await expect(rows.first()).toContainText('◆ Répondre', { timeout: 1_000 });
  await expect(rows.first().getByRole('button', { name: /^Faux CLI 3, / })).toBeVisible();
  await expect(rows.first().getByRole('button', { name: '✓ Autoriser' })).toBeVisible();
  await expect(column.getByRole('button', { name: '✓ Autoriser' })).toHaveCount(1);

  // The others have no action button, the orchestrator included (scenario 3).
  await expect(actionButtons(rows.nth(1))).toHaveCount(0);
  await expect(actionButtons(rows.nth(2))).toHaveCount(0);
  await expect(actionButtons(rows.nth(3))).toHaveCount(0);

  await expectNoSeriousA11yViolations(page);

  // A click on a row opens the agent in the Focus (scenario 5).
  await rows
    .nth(2)
    .getByRole('button', { name: /^Faux CLI \d, / })
    .click();
  await expect(page.getByRole('region', { name: /^Focus : Faux CLI/ })).toBeVisible();
});
