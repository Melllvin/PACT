import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 005 US4 end to end (T028), on the test clock of 001: a rate limit whose message gives no time
// resumes at the reset the gauge knows, not after the intervals of 001.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** `rate-limit-usage`: its 5 h window at 100 % resets at 10:15 (UTC); its message tells no time. */
const RESET = '2030-01-01T10:15:00.000Z';
const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('rate-limit-usage'),
  PACT_TEST_NOW: '2030-01-01T09:00:00.000Z',
};
/** As the tiles show it: the app runs in the time zone of the test. */
const time = new Date(RESET).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

let root: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us27-')));
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

test('resumes at the reset the gauge knows when the message gives no time', async () => {
  test.setTimeout(120_000);
  const repo = await makeRepo('atelier');
  launched = await launchApp({ env });
  const { app } = launched;
  const page = await app.firstWindow();
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();

  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 1);
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter');
  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');

  await typeIn(page, tile, 'Travaille');
  await expect(tile).toContainText('Statut : PACT · 5 h 100 %');
  await expect(tile).toHaveAttribute('data-state', 'error');
  await expect(tile).toContainText(`reprise auto à ${time}`);

  await app.evaluate((_electron, at) => {
    const { pactTestClock } = globalThis as { pactTestClock?: { advanceTo(iso: string): void } };
    if (!pactTestClock) throw new Error('No test clock: PACT_TEST_NOW is ignored');
    pactTestClock.advanceTo(at);
  }, RESET);
  await expect(tile).toHaveAttribute('data-state', 'done');
  await expect(tile).not.toContainText('reprise auto');
});
