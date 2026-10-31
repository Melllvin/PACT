import { rm } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 003 US1 end to end (T020): three fake agents, the first as orchestrator. It leads the tiles from
// the top, and the prompts it sends through PACT's MCP tools reach the other two.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us13-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Opens the repository and launches three fake agents, the first as orchestrator. */
const launchTeam = async (page: Page) => {
  await answerFolderPickers((launched as LaunchedApp).app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = launcher.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' });
  await plus.click();
  await plus.click();
  await plus.click();
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  for (const n of [1, 2, 3]) await expect(tile(n)).toHaveAttribute('data-state', 'awaiting-prompt');
  return tile;
};

test('leads the other agents from the top, and its prompts reach them', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const tile = await launchTeam(page);

  // Chef au centre (FR-003).
  const lead = page.getByRole('region', { name: 'Orchestrateur' });
  await expect(lead.getByRole('article')).toHaveCount(1);
  await expect(tile(1)).toContainText('◎ Orchestrateur');
  const others = page.getByRole('region', { name: 'Agents dirigés' });
  await expect(others.getByRole('article')).toHaveCount(2);

  // Two prompts sent by the orchestrator through PACT (FR-009).
  await typeIn(page, tile(1), 'Faux CLI 2|Écris la fonction');
  await expect(tile(1)).toContainText('MCP send_prompt :');
  await expect(tile(2)).toContainText('Reçu : Écris la fonction');
  await typeIn(page, tile(1), 'Faux CLI 3|Écris ses tests');
  await expect(tile(3)).toContainText('Reçu : Écris ses tests');
  await expect(tile(1)).not.toContainText('HTTP 401');
});
