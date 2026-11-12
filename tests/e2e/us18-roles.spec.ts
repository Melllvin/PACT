import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo } from './helpers/workspace';

// 004 US1 end to end (T012): the role profiles, an orchestrator, a dev and a test launched by role;
// the roles on the tiles and the lead's tile the largest at every window size (FR-001…FR-006a).

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us18-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('sets the profiles, launches by role, shows the roles and keeps the lead the largest', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  // The profiles: a test weaker than the dev warns, without blocking.
  await page.getByRole('button', { name: 'Rôles' }).click();
  const profiles = page.getByRole('dialog', { name: 'Profils de rôle' });
  await profiles
    .getByRole('row', { name: 'Test' })
    .getByRole('combobox', { name: 'Modèle · Test' })
    .selectOption('fake-small');
  await expect(profiles.getByRole('status')).toContainText('plus faible que le profil dev');
  await profiles.getByRole('button', { name: 'Fermer' }).click();

  // An orchestrator, a dev and a test from the detailed launcher.
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = quick
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: /^Ajouter un / });
  await plus.click();
  await plus.click();
  await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
  const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
  const agents = detailed.getByRole('list', { name: 'Agents' }).getByRole('listitem');
  await expect(agents).toHaveCount(3);
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
  await agents
    .nth(0)
    .getByRole('button', { name: /^Faux CLI/ })
    .click();
  await inspector.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await agents
    .nth(1)
    .getByRole('button', { name: /^Faux CLI/ })
    .click();
  await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('dev');
  await agents
    .nth(2)
    .getByRole('button', { name: /^Faux CLI/ })
    .click();
  await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('test');
  await expect(inspector.getByRole('combobox', { name: 'Modèle' })).toHaveValue('fake-small');
  await detailed.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »

  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  const dev = page.getByRole('article', { name: /^Faux CLI 2,/ });
  const tester = page.getByRole('article', { name: /^Faux CLI 3,/ });
  await expect(lead).toContainText('◎ Orchestrateur');
  await expect(dev.getByLabel('Rôle')).toHaveText('Dev');
  await expect(tester.getByLabel('Rôle')).toHaveText('Test');

  const area = async (tile: typeof lead) => {
    const box = await tile.boundingBox();
    return (box?.width ?? 0) * (box?.height ?? 0);
  };
  for (const size of [
    { width: 1024, height: 680 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(async () => (await area(lead)) > Math.max(await area(dev), await area(tester)))
      .toBe(true);
  }
});
