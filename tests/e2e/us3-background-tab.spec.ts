import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// T124 — FR-026: an agent keeps working while another workspace tab is in front; back on its
// tab, nothing of its output is lost and its state is current.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  // 20 000 lines: still pouring out when the other tab comes in front.
  FAKE_CLI_SCENARIO: scenarioPath('long-burst'),
};

let root: string;
let launched: LaunchedApp | undefined;

const makeRepo = async (name: string) => {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-bg-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

test('keeps the output of an agent working behind another tab (FR-026)', async () => {
  test.setTimeout(120_000);
  const first = await makeRepo('atelier');
  const second = await makeRepo('facturation');
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, first, second);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  await page
    .getByRole('dialog', { name: 'Ajouter au workspace' })
    .getByRole('button', { name: 'Lancer 1 agent' })
    .click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');

  await tile.locator('.xterm').click();
  await page.keyboard.type('Rafale');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Nouvel onglet' }).click();
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('tab', { name: 'facturation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(tile).toBeHidden();

  // Back on its tab: the turn ended and the tile shows it.
  await page.getByRole('tab', { name: 'atelier' }).click();
  await expect(tile).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  const rows = tile.locator('.xterm-rows');
  await expect(rows).toContainText('burst 20000');
  // The last lines follow one another: nothing was dropped while hidden.
  const text = (await rows.textContent()) ?? '';
  const numbers = [...text.matchAll(/burst (\d+)/g)].map((m) => Number(m[1]));
  expect(numbers.length).toBeGreaterThan(5);
  expect(numbers).toEqual(numbers.map((_, i) => (numbers[0] ?? 0) + i));
});
