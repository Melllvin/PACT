import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, launchAgents, typeIn } from './helpers/workspace';

// 009 US1 end to end (T020), on the test clock: the account climbs to 80, 87 then 90 % of its 5 h
// window (levels injected by the fake CLI, never read from a real account). At 87 % PACT asks the
// agents to commit locally; at 90 % it stops them, pushes nothing, and says so on the tile.
// Red until UsageLimitService exists (009 phase 3).
const RESET = '2030-01-01T10:15:00.000Z';
const time = new Date(RESET).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
  ({ root, repo } = await createRepo('pact-us40-', { 'README.md': '# test\n' }));
  scratch = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-us40-sc-')));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

/** A copy of the scenario with `patch` applied: the mute agent (`onPointer: 'ignore'`), a long turn. */
const variant = async (name: string, patch: Record<string, unknown>) => {
  const base = JSON.parse(await readFile(scenarioPath('usage-stop'), 'utf8')) as object;
  const file = join(scratch, `${name}.json`);
  await writeFile(file, JSON.stringify({ ...base, ...patch }));
  return file;
};

const start = async (scenario: string) => {
  launched = await launchApp({ env: { ...baseEnv, FAKE_CLI_SCENARIO: scenario } });
  const page = await launched.app.firstWindow();
  const tiles = await launchAgents(launched, page, repo, 1);
  const tile = tiles[0];
  if (!tile) throw new Error('no tile');
  return { page, tile };
};

test('commits at 87 %, then is stopped at 90 % with its work saved and nothing pushed (sc. 1, 2, 3, 6)', async () => {
  test.setTimeout(120_000);
  const before = git(repo, 'rev-parse', 'HEAD');
  const { page, tile } = await start(scenarioPath('usage-stop'));
  await typeIn(page, tile, 'Premier tour');
  await typeIn(page, tile, 'Deuxième tour');

  await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect(tile).toContainText(`en pause · reprise à ${time}`);
  await expect(tile).not.toContainText('non sauvegardé');
  // The agent committed in its worktree; PACT made no commit and pushed nothing.
  expect(git(agentWorktree(repo), 'status', '--porcelain')).toBe('');
  expect(git(agentWorktree(repo), 'log', '-1', '--format=%s')).toBe('pact: sauvegarde');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(repo, 'remote')).toBe('');
});

test('an agent that does not commit is stopped all the same and shows « non sauvegardé » (sc. 4)', async () => {
  test.setTimeout(120_000);
  const { page, tile } = await start(await variant('mute', { onPointer: 'ignore' }));
  await typeIn(page, tile, 'Premier tour');
  await typeIn(page, tile, 'Deuxième tour');

  await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect(tile).toContainText('non sauvegardé');
  expect(git(agentWorktree(repo), 'status', '--porcelain')).toContain('travail.txt');
});

test('an agent in the middle of a turn is stopped too, and its pause says so (sc. 11, 12)', async () => {
  test.setTimeout(120_000);
  const { page, tile } = await start(
    await variant('mid-turn', { toolHooks: { times: 40, everyMs: 500 } }),
  );
  await typeIn(page, tile, 'Premier tour');
  await typeIn(page, tile, 'Deuxième tour');

  await expect(tile).toHaveAttribute('data-state', 'paused', { timeout: 60_000 });
  await expect(tile).toContainText(`en pause · reprise à ${time}`);
});
