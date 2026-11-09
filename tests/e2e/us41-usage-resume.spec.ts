import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, outputOf, typeIn } from './helpers/workspace';

// 009 US2 end to end (T031), on the test clock: the account reaches its threshold (levels injected by the fake
// CLI, never read from a real account), the agents are paused, and the clock reaches the reset of the 5 h window
// (10:15). Red until the resume exists (009 phase 4). Sc. 7 (the orchestrator first) needs an orchestrator with
// its MCP access: it is covered by tests/integration/usage/usage-resume.test.ts and the unit tests of the service.
const RESET = '2030-01-01T10:15:00.000Z';
const baseEnv = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  PACT_TEST_NOW: '2030-01-01T09:00:00.000Z',
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;
let scratch: string;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us41-', { 'README.md': '# test\n' }));
  scratch = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us41-sc-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

/** A copy of the scenario with `patch` applied. */
const variant = async (name: string, patch: Record<string, unknown>) => {
  const base = JSON.parse(await readFile(scenarioPath('usage-resume'), 'utf8')) as object;
  const file = join(scratch, `${name}.json`);
  await writeFile(file, JSON.stringify({ ...base, ...patch }));
  return file;
};

const current = () => {
  if (!launched) throw new Error('PACT is not running');
  return launched;
};

const advanceTo = (app: ElectronApplication, at: string) =>
  app.evaluate((_electron, iso) => {
    const { pactTestClock } = globalThis as { pactTestClock?: { advanceTo(iso: string): void } };
    if (!pactTestClock) throw new Error('No test clock: PACT_TEST_NOW is ignored');
    pactTestClock.advanceTo(iso);
  }, at);

/** Two turns bring the account to 90 %: 87 % asks to commit, 90 % stops the agent. */
const pauseOne = async (page: Page, tile: Locator) => {
  await typeIn(page, tile, 'Premier tour');
  await typeIn(page, tile, 'Deuxième tour');
  await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
};

const start = async (scenario: string, count = 1, extra: Record<string, string> = {}) => {
  launched = await launchApp({ env: { ...baseEnv, ...extra, FAKE_CLI_SCENARIO: scenario } });
  const page = await launched.app.firstWindow();
  const tiles = await launchAgents(launched, page, repo, count);
  return { page, tiles };
};

test('at the reset the agents start again in their session, with a pointer for the one stopped mid-turn (sc. 1, 3; SC-004)', async () => {
  test.setTimeout(180_000);
  const { page, tiles } = await start(
    await variant('mid-turn', { toolHooks: { times: 40, everyMs: 500 } }),
  );
  const [tile] = tiles;
  if (!tile) throw new Error('no tile');
  await pauseOne(page, tile);

  await advanceTo(current().app, RESET);

  // Less than a minute after the reset (SC-004): the agent is up again in its own session.
  await expect(tile).not.toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect(tile).not.toContainText('en pause');
  await expect.poll(() => outputOf(page, 1), { timeout: 60_000 }).toContain('Session reprise');
  // Stopped mid-turn: PACT hands it a pointer once it is ready, and it goes on with its work.
  await expect
    .poll(() => outputOf(page, 1), { timeout: 60_000 })
    .toMatch(/événements?, lis get_events/);
});

test('an agent idle at the stop is resumed without any pointer (sc. 3)', async () => {
  test.setTimeout(180_000);
  const { page, tiles } = await start(scenarioPath('usage-resume'));
  const [tile] = tiles;
  if (!tile) throw new Error('no tile');
  await pauseOne(page, tile);

  await advanceTo(current().app, RESET);
  await expect(tile).not.toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect.poll(() => outputOf(page, 1), { timeout: 60_000 }).toContain('Session reprise');
  await page.waitForTimeout(2_000);
  expect(await outputOf(page, 1)).not.toMatch(/lis get_events/);
});

test('PACT reopened after the reset resumes the paused agent at once (sc. 4)', async () => {
  test.setTimeout(180_000);
  const { page, tiles } = await start(scenarioPath('usage-resume'));
  const [tile] = tiles;
  if (!tile) throw new Error('no tile');
  await pauseOne(page, tile);

  const { userDataDir } = current();
  await current().close({ keepData: true });
  // The night went by: PACT opens again after the reset.
  launched = await launchApp({
    userDataDir,
    env: {
      ...baseEnv,
      PACT_TEST_NOW: '2030-01-01T10:30:00.000Z',
      FAKE_CLI_SCENARIO: scenarioPath('usage-resume'),
    },
  });
  const again = await launched.app.firstWindow();
  const back = again.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(back).toBeVisible({ timeout: 30_000 });
  // Never « à reprendre » (error), and no wait for the user: the due resume ran.
  await expect(back).not.toHaveAttribute('data-state', 'error');
  await expect(back).not.toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect.poll(() => outputOf(again, 1), { timeout: 60_000 }).toContain('Session reprise');
});

test('« Reprendre » on the tile resumes that agent, and it is not stopped again before the next reset (sc. 8)', async () => {
  test.setTimeout(180_000);
  // Every turn reads 91 %: without an override the agent would be stopped again at once.
  const hot = await variant('hot', {
    usage: [{ five_hour: 91, seven_day: 20, resets_at: 1893492900, tokens: 100 }],
  });
  const { page, tiles } = await start(hot);
  const [tile] = tiles;
  if (!tile) throw new Error('no tile');
  await typeIn(page, tile, 'Premier tour');
  await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });

  await tile.hover();
  await tile.getByRole('button', { name: 'Reprendre' }).click();
  await expect(tile).not.toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await expect.poll(() => outputOf(page, 1), { timeout: 30_000 }).toContain('Session reprise');

  await typeIn(page, tile, 'Encore un tour');
  await page.waitForTimeout(5_000);
  await expect(tile).not.toHaveAttribute('data-state', 'paused');
  await expect(tile).not.toContainText('en pause');
});
