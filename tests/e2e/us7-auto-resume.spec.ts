import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// US7 end to end with the fake CLI on a test clock: « reprise auto à HH:MM · Annuler » on the tile
// and in À faire, the resume without any action, and « Annuler » (T106).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** The fake CLI stays alive after its rate limit, which lifts at 09:30 (UTC). */
const RESET = '2030-01-01T09:30:00.000Z';
const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('rate-limit-alive'),
  PACT_TEST_NOW: '2030-01-01T09:00:00.000Z',
};
/** As the tiles show it: the app runs in the time zone of the test. */
const time = new Date(RESET).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

let root: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us7-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const makeRepo = async (name: string) => {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  return repo;
};

/** Sets a counter of the quick launcher (1c) to `target`. */
const setCount = async (group: Locator, target: number) => {
  const count = group.getByRole('status');
  for (;;) {
    const value = Number(await count.textContent());
    if (value === target) return;
    await group.getByRole('button', { name: value < target ? '+' : '−' }).click();
  }
};

/** Types in the terminal of a tile, as the user would after clicking into it. */
const typeIn = async (page: Page, tile: Locator, text: string) => {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('resumes a rate-limited agent at the reset time, unless cancelled', async () => {
  test.setTimeout(120_000);
  const repo = await makeRepo('atelier');
  launched = await launchApp({ env });
  const { app } = launched;
  const page = await app.firstWindow();
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 2);
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  // 1m: « Toujours autoriser », with « Reprendre automatiquement » checked by default.
  await page.keyboard.press('Enter');
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  for (const n of [1, 2]) await expect(tile(n)).toHaveAttribute('data-state', 'awaiting-prompt');

  // Both meet the rate limit: the scheduled resume shows on the tiles and in À faire.
  await typeIn(page, tile(1), 'Travaille');
  await typeIn(page, tile(2), 'Travaille');
  for (const n of [1, 2]) {
    await expect(tile(n)).toHaveAttribute('data-state', 'error');
    await expect(tile(n)).toContainText(`reprise auto à ${time}`);
  }
  const column = page.getByRole('complementary', { name: 'À faire' });
  await expect(column.getByText(`reprise auto à ${time}`)).toHaveCount(2);

  // « Annuler » on agent 2: no resume any more, the manual actions stay.
  await tile(2).getByRole('button', { name: 'Annuler' }).click();
  await expect(tile(2)).not.toContainText('reprise auto');
  await expect(column.getByText(`reprise auto à ${time}`)).toHaveCount(1);

  // At the reset time agent 1 resumes on its own; agent 2 waits for the user.
  await app.evaluate((_electron, at) => {
    const { pactTestClock } = globalThis as { pactTestClock?: { advanceTo(iso: string): void } };
    if (!pactTestClock) throw new Error('No test clock: PACT_TEST_NOW is ignored');
    pactTestClock.advanceTo(at);
  }, RESET);
  await expect(tile(1)).toHaveAttribute('data-state', 'done');
  await expect(tile(1)).not.toContainText('reprise auto');
  await expect(tile(2)).toHaveAttribute('data-state', 'error');
  await expect(tile(2).getByRole('button', { name: 'Reprendre' })).toBeVisible();
});
