import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// 005 US3 end to end (T025): three fake agents whose tokens are known; the detail of the gauge
// gives each its part, the largest first.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us26-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const makeRepo = async () => {
  const repo = join(root, 'atelier');
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

test('gives the part of each agent, the largest first', async () => {
  test.setTimeout(150_000);
  const repo = await makeRepo();
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      FAKE_CLI_SCENARIO: scenarioPath('usage-shares'),
    },
  });
  const { app } = launched;
  const page = await app.firstWindow();
  await answerFolderPickers(app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await setCount(launcher.getByRole('group', { name: 'Faux CLI' }), 3);
  await launcher.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter');
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  for (const n of [1, 2, 3]) await expect(tile(n)).toHaveAttribute('data-state', 'awaiting-prompt');

  // Agent 1 three turns (900 tokens after its first reading), 2 two (300), 3 one (0).
  const turns: [number, number][] = [
    [1, 30],
    [1, 31],
    [1, 32],
    [2, 30],
    [2, 31],
    [3, 30],
  ];
  for (const [n, percent] of turns) {
    await tile(n).locator('.xterm').click();
    await page.keyboard.type('Travaille');
    await page.keyboard.press('Enter');
    await expect(tile(n)).toContainText(`Statut : PACT · 5 h ${String(percent)} %`);
  }

  const gauges = page.getByRole('group', { name: 'Limites d’usage' });
  await gauges.getByRole('button', { name: /Faux CLI/ }).click();
  const parts = page.getByRole('list', { name: 'Part des agents PACT' });
  await expect(parts.getByRole('listitem')).toHaveText([
    /^Faux CLI 1\s*75 %$/,
    /^Faux CLI 2\s*25 %$/,
    /^Faux CLI 3\s*0 %$/,
  ]);
});
