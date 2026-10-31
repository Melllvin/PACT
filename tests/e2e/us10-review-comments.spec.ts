import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, typeIn } from './helpers/workspace';

// 002 US3 end to end (T039): a comment on a line reaches the fake CLI with its file and line,
// nothing is typed while the agent waits for an answer, and « Corriger les commentaires · 2 »
// sends both in one prompt.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('edit-ask-echo'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us10-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('sends comments to the agent only when it is ready, then all of them in one prompt', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const [tile] = await launchAgents(launched, page, repo);
  if (!tile) throw new Error('no tile');

  // First turn: the agent asks, then writes src/a.ts.
  await typeIn(page, tile, 'Ajoute a');
  await expect(tile).toHaveAttribute('data-state', 'awaiting-answer');
  await tile.getByRole('button', { name: 'Autoriser' }).click();
  await expect(tile).toHaveAttribute('data-state', 'done');
  await tile.getByRole('button', { name: 'Revue →' }).click();

  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  const terminal = focus.getByLabel('Terminal de Faux CLI 1');
  const diff = focus.getByRole('table', { name: 'Diff de src/a.ts' });

  // A comment on line 2, typed at once since the agent is done (scenario 1, SC-004).
  await diff.getByRole('button', { name: 'Commenter la ligne 2' }).click();
  await focus.getByRole('textbox', { name: 'Commentaire sur la ligne 2' }).fill('Plutôt « 2 ».');
  await page.keyboard.press('Enter');
  await expect(focus.getByRole('note', { name: 'Commentaire sur la ligne 2' })).toContainText(
    '→ envoyé à l’agent ↓',
  );
  await expect(terminal).toContainText('Reçu : Commentaire sur src/a.ts:2 — Plutôt « 2 ».', {
    timeout: 1000,
  });

  // The agent asks again: a second comment waits for the answer (scenario 4, FR-014).
  await expect(focus).toHaveAttribute('data-state', 'awaiting-answer');
  await diff.getByRole('button', { name: 'Commenter la ligne 3' }).click();
  await focus.getByRole('textbox', { name: 'Commentaire sur la ligne 3' }).fill('Et « 3 ».');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await expect(terminal).not.toContainText('src/a.ts:3');
  await focus.getByRole('button', { name: 'Autoriser' }).click();
  await expect(terminal).toContainText('Reçu : Commentaire sur src/a.ts:3 — Et « 3 ».');
  await expect(focus).toHaveAttribute('data-state', 'awaiting-answer');
  await focus.getByRole('button', { name: 'Autoriser' }).click();
  await expect(focus).toHaveAttribute('data-state', 'done');

  // Both comments in one prompt (scenario 2).
  await focus.getByRole('button', { name: 'Corriger les commentaires · 2' }).click();
  await expect(terminal).toContainText('Reçu : Corrige les commentaires de revue suivants :');
  await expect(terminal).toContainText('- src/a.ts:2 — Plutôt « 2 ».');
  await expect(terminal).toContainText('- src/a.ts:3 — Et « 3 ».');
  await expect(focus.getByRole('button', { name: /Corriger les commentaires/ })).toHaveCount(0);
});
