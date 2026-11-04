import { rm } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, typeIn } from './helpers/workspace';

// T162 — a question from the CLI is answered in its terminal, never with « 1 » (001 FR-024a).

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('ask-question'),
};

let root: string;
let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('opens the terminal of an agent that asks a question, from its tile and from À faire', async () => {
  test.setTimeout(90_000);
  const created = await createRepo('pact-question-', { 'README.md': '# test\n' });
  root = created.root;
  const { repo } = created;
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  const [tile] = await launchAgents(launched, page, repo);
  if (!tile) throw new Error('no tile');

  await typeIn(page, tile, 'Choisis une base');
  await expect(tile).toHaveAttribute('data-state', 'awaiting-answer');
  await expect(tile.getByRole('button', { name: '✓ Autoriser' })).toHaveCount(0);
  const column = page.getByRole('complementary', { name: 'Agents' });
  await expect(column.getByRole('button', { name: '✓ Autoriser' })).toHaveCount(0);

  await tile.getByRole('button', { name: 'Répondre dans le terminal ↗' }).click();
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await expect(focus).toBeVisible();
  await expect(focus.locator('.xterm')).toBeVisible();
  await focus.getByRole('button', { name: '‹ Tuiles' }).click();

  await column.getByRole('button', { name: 'Répondre dans le terminal ↗' }).click();
  await expect(focus).toBeVisible();
  // Nothing was typed for the user: the CLI only got the prompt.
  await expect(focus).not.toContainText('Autorisé');
});
