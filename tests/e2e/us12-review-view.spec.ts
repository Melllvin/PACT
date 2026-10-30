import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, git, launchAgents, typeIn } from './helpers/workspace';

// 002 US5 end to end (T053): two agents with changes, the Revue badge at 2, from one review to
// the other by the pills, one abandoned: the badge drops to 1 and main has not moved.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('edit-echo'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us12-', { 'src/a.ts': 'un\ndeux\ntrois\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('goes through the reviews of two agents, then abandons one', async () => {
  test.setTimeout(120_000);
  const main = git(repo, 'rev-parse', 'main');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const tiles = await launchAgents(launched, page, repo, 2);
  for (const tile of tiles) {
    await typeIn(page, tile, 'Change la ligne 2');
    await expect(tile).toHaveAttribute('data-state', 'done');
  }

  const revue = page.getByRole('radio', { name: /Revue/ });
  await expect(revue).toHaveText('Revue2');
  await revue.click();
  await expect(page.getByRole('region', { name: 'Focus : Faux CLI 1' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Décision' })).toBeVisible();

  await page.getByRole('radio', { name: 'Faux CLI 2' }).click();
  const second = page.getByRole('region', { name: 'Focus : Faux CLI 2' });
  await expect(second.getByRole('tab', { name: 'Changements' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // « ✕ Abandonner »: a confirmation, then the question of closing an agent (FR-032).
  const decision = page.getByRole('complementary', { name: 'Décision' });
  await decision.getByRole('button', { name: '✕ Abandonner' }).click();
  await decision.getByRole('alertdialog').getByRole('button', { name: 'Abandonner' }).click();
  const closing = page.getByRole('dialog', { name: 'Fermer Faux CLI 2' });
  await closing.getByRole('radio', { name: /Supprimer/ }).click();
  await closing.getByRole('button', { name: 'Fermer l’agent' }).click();

  await expect(page.getByRole('article', { name: /^Faux CLI 2,/ })).toHaveCount(0);
  await expect(revue).toHaveText('Revue1');
  expect(git(repo, 'rev-parse', 'main')).toBe(main);
  expect(git(repo, 'branch', '--list', 'agent/fake-2')).toBe('');
});
