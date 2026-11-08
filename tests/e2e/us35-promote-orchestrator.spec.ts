import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, typeIn } from './helpers/workspace';

// 006 US5 end to end (T040, FR-027, FR-028): a plain agent becomes the orchestrator, keeps its
// tile at the top, and what it launches is linked to it. (Not us32: taken by us32-exchanges.)

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-two-agents'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us35-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('makes an agent the orchestrator: restarted with its access, it launches a linked agent (T040)', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const [tile] = await launchAgents(launched, page, repo, 1);
  if (!tile) throw new Error('no tile');
  await expect(tile.getByLabel('Rôle')).toHaveCount(0);

  // « Faire orchestrateur » in the ⋮ menu of the tile, then the confirmation.
  await tile.hover();
  await tile.getByRole('button', { name: 'Plus d’actions' }).click();
  await page.getByRole('menuitem', { name: 'Faire orchestrateur' }).click();
  await page
    .getByRole('dialog', { name: 'Faire orchestrateur ?' })
    .getByRole('button', { name: 'Confirmer' })
    .click();

  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(lead.getByLabel('Rôle')).toContainText('Orchestrateur');
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt', { timeout: 20_000 });
  await expect(lead.locator('.xterm-rows')).toContainText('Session reprise');

  // As an orchestrator it launches an agent, whose tile comes beside it at once, linked to it.
  await typeIn(page, lead, 'feat/promu|feat/autre|Écris la fonction');
  await expect(lead).toContainText('Faux CLI 2 lancé sur feat/promu', { timeout: 20_000 });
  const child = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(child).toBeVisible({ timeout: 1_000 });
  const [l, c] = [await lead.boundingBox(), await child.boundingBox()];
  expect(l && c && l.height > c.height * 1.5).toBe(true);

  // The link: the Agents column or the graph says who launched it.
  await page.getByRole('radio', { name: 'Graphe' }).click();
  await expect(
    page.getByRole('button', { name: /^Faux CLI 2, .*lancé par Faux CLI 1$/ }),
  ).toBeVisible();
});
