import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, typeIn } from './helpers/workspace';

// 004 US5 end to end (T038): the orchestrator keeps the recap of two issues; it opens first in the
// Aperçu of its Focus, with what to test by hand, and follows the file as it changes (FR-029,
// FR-030).

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us22-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const RECAP = '.pact/recap.md';

test('shows the recap first in the Aperçu of the orchestrator and follows its changes', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('recap-writer'),
    },
  });
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
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');

  // The orchestrator writes an issue and the recap of the two issues.
  await typeIn(page, lead, 'Tiens le recap');
  await expect(lead).not.toHaveAttribute('data-state', 'working');

  await lead.getByRole('button', { name: 'Agrandir' }).click();
  await page.getByRole('tab', { name: 'Aperçu' }).click();
  const files = page.getByRole('list', { name: 'Fichiers de l’Aperçu' });
  await expect(files.getByRole('button')).toHaveText([
    `Recap${RECAP}`,
    'Issue.pact/issues/0012-connexion.md',
  ]);
  await expect(files.getByRole('button', { name: new RegExp(RECAP) })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const shown = page.frameLocator(`iframe[title="Aperçu : ${RECAP}"]`);
  await expect(shown.getByRole('heading', { level: 1 })).toHaveText('Recap — 3 novembre');
  await expect(shown.getByRole('heading', { level: 2 })).toHaveText([
    '0012-connexion · Connexion par e-mail — terminée',
    '0013-profil · Page profil — en cours',
  ]);
  await expect(shown.getByRole('heading', { name: 'À tester à la main' })).toHaveCount(2);
  await expect(shown.getByText('Se connecter avec un vrai e-mail.')).toBeVisible();

  // The orchestrator closes the second issue: shown within 2 s (US5 scenario 2).
  const file = join(agentWorktree(repo, 1), RECAP);
  const recap = await readFile(file, 'utf8');
  await writeFile(file, recap.replace('Page profil — en cours', 'Page profil — terminée'));
  await expect(shown.getByRole('heading', { level: 2 }).nth(1)).toHaveText(
    '0013-profil · Page profil — terminée',
    { timeout: 2_000 },
  );
});
