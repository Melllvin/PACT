import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, typeIn } from './helpers/workspace';

// 004 US4 end to end (T034): a design agent writes a mockup that loads a remote image; the Aperçu
// shows it with no network request and tells the block, follows its changes, and the user's
// decision reaches the orchestrator (FR-025 to FR-028, SC-004).

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us21-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const MOCKUP = 'design/mockups/accueil.html';

test('shows the mockup isolated, follows its changes and takes the decision to the orchestrator', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('mockup-writer'),
    },
  });
  const page = await launched.app.firstWindow();
  // A request the policy blocks may be announced, never answered.
  const remote: string[] = [];
  page.on('requestfinished', (request) => {
    if (/^https?:/.test(request.url())) remote.push(request.url());
  });
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
  const design = page.getByRole('article', { name: /^Faux CLI 2,/ });
  await expect(design).toHaveAttribute('data-state', 'awaiting-prompt');

  // The design agent writes its mockup.
  await typeIn(page, design, 'Dessine l’accueil');
  await expect(design).not.toHaveAttribute('data-state', 'working');

  await design.getByRole('button', { name: 'Agrandir' }).click();
  await page.getByRole('tab', { name: 'Aperçu' }).click();
  await expect(page.getByRole('list', { name: 'Fichiers de l’Aperçu' })).toContainText(MOCKUP);
  const shown = page.frameLocator(`iframe[title="Aperçu : ${MOCKUP}"]`);
  await expect(shown.getByRole('heading')).toHaveText('Accueil v1');
  await expect(page.getByText('Ressource externe bloquée :')).toHaveText(
    'Ressource externe bloquée : https://example.invalid/a.png',
  );
  expect(remote).toEqual([]);

  // A change of the file is shown within 2 s (FR-027).
  await writeFile(
    join(agentWorktree(repo, 2), MOCKUP),
    '<!doctype html><html><head><title>Accueil</title></head><body><h1>Accueil v2</h1></body></html>',
  );
  await expect(shown.getByRole('heading')).toHaveText('Accueil v2', { timeout: 2_000 });

  // The user validates it; the orchestrator hears it (SC-004).
  await page.getByLabel('Commentaire sur la maquette').fill('Parfait');
  await page.getByRole('button', { name: '✓ Valider' }).click();
  await expect(page.getByText('✓ Maquette validée — transmis à l’orchestrateur.')).toBeVisible();
  await page.getByRole('button', { name: '‹ Tuiles' }).click();
  await typeIn(page, lead, 'wait_for_agents|{"timeoutSeconds":5}');
  await expect(lead).toContainText(
    `maquette ${MOCKUP} validée par l’utilisateur. Commentaire : Parfait`,
  );
});
