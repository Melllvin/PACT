import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, launchAgents, typeIn } from './helpers/workspace';

// 009 US3 end to end (T039), on the test clock: the account reads 82 % of its 5 h window once (levels injected by the
// fake CLI, never read from a real account) while the agent keeps working. The reading is made at 09:00 and the clock
// then moves: 16 minutes later the reading is too old and PACT offers to stop by caution, never alone (SC-006).
// Red until the offer exists (009 phase 5). The part of US4 (the threshold) is written in its own describe.
const baseEnv = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  PACT_TEST_NOW: '2030-01-01T09:00:00.000Z',
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

const advanceTo = (app: ElectronApplication, at: string) =>
  app.evaluate((_electron, iso) => {
    const { pactTestClock } = globalThis as { pactTestClock?: { advanceTo(iso: string): void } };
    if (!pactTestClock) throw new Error('No test clock: PACT_TEST_NOW is ignored');
    pactTestClock.advanceTo(iso);
  }, at);

const current = () => {
  if (!launched) throw new Error('PACT is not running');
  return launched;
};

test.describe('a reading too old (US3)', () => {
  test.beforeEach(async () => {
    ({ root, repo } = await createRepo('pact-us42-', { 'README.md': '# test\n' }));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /** One agent at work in the middle of a long turn, the account read once at 82 % at 09:00. */
  const working = async (): Promise<{ page: Page; tile: Locator; offer: Locator }> => {
    launched = await launchApp({
      env: { ...baseEnv, FAKE_CLI_SCENARIO: scenarioPath('usage-stale') },
    });
    const page = await launched.app.firstWindow();
    const [tile] = await launchAgents(launched, page, repo, 1);
    if (!tile) throw new Error('no tile');
    await typeIn(page, tile, 'Travaille longtemps');
    await expect(tile).toHaveAttribute('data-state', 'working', { timeout: 30_000 });
    // The fake CLI reports its limits after the prompt: the clock moves only once the reading is made (09:00).
    await expect(
      page
        .getByRole('group', { name: 'Limites d’usage' })
        .getByRole('button', { name: /Faux CLI 82 % · 5 h/ }),
    ).toBeVisible({ timeout: 30_000 });
    const todos = page.getByRole('complementary', { name: 'Agents' });
    const offer = todos.getByRole('listitem').filter({ hasText: /Limite Faux CLI inconnue/ });
    return { page, tile, offer };
  };

  test('offers to stop by caution after 15 minutes, with two buttons, and stops nothing by itself (sc. 1; SC-006)', async () => {
    test.setTimeout(120_000);
    const { tile, offer } = await working();

    await advanceTo(current().app, '2030-01-01T09:14:00.000Z');
    await expect(tile).toHaveAttribute('data-state', 'working');
    await expect(offer).toHaveCount(0);

    await advanceTo(current().app, '2030-01-01T09:16:00.000Z');
    await expect(offer).toHaveCount(1, { timeout: 30_000 });
    await expect(offer).toContainText('Limite Faux CLI inconnue depuis 16 min');
    await expect(offer).toContainText('dernière lecture 5 h à 82 %');
    await expect(offer).toContainText('Arrêter par prudence ?');
    await expect(offer.getByRole('button', { name: 'Arrêter par prudence' })).toBeVisible();
    await expect(offer.getByRole('button', { name: 'Pas maintenant' })).toBeVisible();

    // Nobody answers: the agent keeps working, whatever the time.
    await advanceTo(current().app, '2030-01-01T11:00:00.000Z');
    await expect(tile).toHaveAttribute('data-state', 'working');
  });

  test('« Pas maintenant » stops nothing and the offer comes back at the next step of 15 minutes (sc. 2)', async () => {
    test.setTimeout(120_000);
    const { tile, offer } = await working();
    await advanceTo(current().app, '2030-01-01T09:16:00.000Z');
    await expect(offer).toHaveCount(1, { timeout: 30_000 });

    await offer.getByRole('button', { name: 'Pas maintenant' }).click();
    await expect(offer).toHaveCount(0);
    await expect(tile).toHaveAttribute('data-state', 'working');

    await advanceTo(current().app, '2030-01-01T09:29:00.000Z');
    await expect(offer).toHaveCount(0);
    await advanceTo(current().app, '2030-01-01T09:30:00.000Z');
    await expect(offer).toHaveCount(1, { timeout: 30_000 });
    await expect(offer).toContainText('inconnue depuis 30 min');
    await expect(tile).toHaveAttribute('data-state', 'working');
  });

  test('« Arrêter par prudence » pauses the agent within a minute, on its tile (sc. 3)', async () => {
    test.setTimeout(120_000);
    const { tile, offer } = await working();
    await advanceTo(current().app, '2030-01-01T09:16:00.000Z');
    await expect(offer).toHaveCount(1, { timeout: 30_000 });

    await offer.getByRole('button', { name: 'Arrêter par prudence' }).click();
    await expect(offer).toHaveCount(0);

    // The instruction goes at once; the stop waits for the end of the turn, or 60 s at most.
    await advanceTo(current().app, '2030-01-01T09:17:01.000Z');
    await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
    await expect(tile).toContainText('en pause');
  });
});
