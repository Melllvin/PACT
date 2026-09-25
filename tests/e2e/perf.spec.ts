import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';

// T112 — SC-002 (typing stays under 100 ms with 6 busy agents) and SC-003 (a question shows in
// À faire in under 2 s).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const fakeEnv = (scenario: string) => ({
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath(scenario),
});

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-perf-')));
  repo = join(root, 'perf');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# perf\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
};

/** Opens the repository and launches 6 fake agents, all waiting for a prompt. */
const launchSix = async (scenario: string) => {
  launched = await launchApp({ env: fakeEnv(scenario) });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = launcher.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' });
  for (let i = 1; i < 6; i++) await plus.click();
  await launcher.getByRole('button', { name: 'Lancer 6 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  for (let n = 1; n <= 6; n++) {
    await expect(tile(n)).toHaveAttribute('data-state', 'awaiting-prompt', { timeout: 20_000 });
  }
  return { page, tile };
};

const typeIn = async (page: Page, tile: Locator, text: string) => {
  await tile.locator('.xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

test('echoes a keystroke in under 100 ms (p95) while 5 other agents pour out output (SC-002)', async () => {
  test.setTimeout(120_000);
  const { page, tile } = await launchSix('burst-output');

  // Each prompt makes an agent print 2 000 lines; three prompts each keep them busy.
  for (let n = 2; n <= 6; n++) for (let i = 0; i < 3; i++) await typeIn(page, tile(n), 'go');

  const measured = tile(1);
  await measured.locator('.xterm').click();
  // From the keydown in the page to the character painted in the terminal rows.
  await measured.locator('.xterm-rows').evaluate((rows) => {
    const probe = { typed: '', since: 0, samples: [] as number[] };
    Object.assign(window, { pactProbe: probe });
    document.addEventListener(
      'keydown',
      (event) => {
        probe.typed += event.key;
        probe.since = performance.now();
      },
      true,
    );
    new MutationObserver(() => {
      if (probe.since && rows.textContent.includes(`> ${probe.typed}`)) {
        probe.samples.push(performance.now() - probe.since);
        probe.since = 0;
      }
    }).observe(rows, { childList: true, subtree: true, characterData: true });
  });

  const keys = 'abcdefghijklmnopqrst'.split('');
  for (const [index, key] of keys.entries()) {
    await page.keyboard.press(key);
    await page.waitForFunction(
      (count) =>
        (window as unknown as { pactProbe: { samples: number[] } }).pactProbe.samples.length >=
        count,
      index + 1,
    );
  }
  const samples = await page.evaluate(
    () => (window as unknown as { pactProbe: { samples: number[] } }).pactProbe.samples,
  );
  test.info().annotations.push({
    type: 'echo p95 (ms)',
    description: percentile(samples, 95).toFixed(1),
  });
  expect(samples).toHaveLength(keys.length);
  expect(percentile(samples, 95)).toBeLessThan(100);
});

test('shows a question of any of 6 agents in À faire in under 2 s (SC-003)', async () => {
  test.setTimeout(120_000);
  const { page, tile } = await launchSix('ask-permission');
  const answers = page
    .getByRole('complementary', { name: 'À faire' })
    .getByRole('listitem')
    .filter({ hasText: '◆ Répondre' });

  const delays: number[] = [];
  for (let n = 1; n <= 6; n++) {
    await tile(n).locator('.xterm').click();
    await page.keyboard.type('Supprime le fichier');
    const start = Date.now();
    await page.keyboard.press('Enter');
    await expect(answers).toHaveCount(n, { timeout: 5_000 });
    delays.push(Date.now() - start);
  }
  test.info().annotations.push({ type: 'À faire delays (ms)', description: delays.join(', ') });
  expect(percentile(delays, 95)).toBeLessThan(2_000);
});
