import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, launchAgents, typeIn } from './helpers/workspace';

// 009 US4 end to end (T045): the thresholds of the stop are set in the settings of the gauge, by CLI and by
// window, and apply at once. The fake CLI reads 80 % of its 5 h window and 20 % of its week (levels injected, never
// read from a real account). Red until the section « Arrêt » exists (009 phase 6). This describe is self-contained:
// the part of US3 of this file (the stale reading) has its own setup.

test.describe('009 US4 — the stop threshold in the settings', () => {
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
    ({ root, repo } = await createRepo('pact-us42-stops-', { 'README.md': '# test\n' }));
    scratch = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us42-stops-sc-')));
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

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

  /** One agent, one turn: the gauge reads 80 % and the agent has ended its turn. */
  const startAtEighty = async () => {
    launched = await launchApp({
      env: { ...baseEnv, FAKE_CLI_SCENARIO: scenarioPath('usage-stops') },
    });
    const page = await launched.app.firstWindow();
    const [tile] = await launchAgents(launched, page, repo, 1);
    if (!tile) throw new Error('no tile');
    await typeIn(page, tile, 'Premier tour');
    await expect(page.getByRole('meter', { name: 'Limite d’usage Faux CLI' })).toHaveAttribute(
      'aria-valuenow',
      '80',
      { timeout: 30_000 },
    );
    await expect(tile).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    return { page, tile };
  };

  const openSettings = async (page: Page) => {
    await page.getByRole('button', { name: /^Faux CLI 80 %/ }).click();
    await page.getByRole('button', { name: 'Seuils d’alerte…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Seuils d’alerte' });
    return { dialog, section: dialog.getByRole('group', { name: 'Arrêt' }) };
  };

  test('the settings show a threshold per window of the CLI, at 90 % by default (sc. 1)', async () => {
    test.setTimeout(120_000);
    const { page } = await startAtEighty();
    const { section } = await openSettings(page);

    await expect(section).toBeVisible();
    await expect(section.getByRole('spinbutton', { name: /^5 h : arrêt à/ })).toHaveValue('90');
    await expect(section.getByRole('spinbutton', { name: /^semaine : arrêt à/ })).toHaveValue('90');
    await expect(section).toContainText('Sauvegarde demandée 3 points avant.');
  });

  test('a threshold lowered under the consumption asks for a save, then stops the agent (sc. 2)', async () => {
    test.setTimeout(180_000);
    const { page, tile } = await startAtEighty();
    const { section } = await openSettings(page);

    await section.getByRole('spinbutton', { name: /^5 h : arrêt à/ }).fill('70');
    await section.getByRole('button', { name: 'Enregistrer' }).click();

    // The stop waits for the end of the turn or 60 s at most: the clock moves past them.
    await advanceTo(current().app, '2030-01-01T09:02:00.000Z');
    await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
    await expect(tile).toContainText('en pause');
    // The agent saved its work in its worktree on the instruction; nothing was pushed.
    expect(git(agentWorktree(repo), 'log', '-1', '--format=%s')).toBe('pact: sauvegarde');
  });
});
