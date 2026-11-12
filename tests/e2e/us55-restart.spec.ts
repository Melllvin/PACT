import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US6 end to end (T050): nothing is lost, nothing is mixed up. sc.1: PACT restarts while the CI of
// a PR runs, the follow goes on, no second PR, no second merge (SC-005). sc.3 and 4: the user closes an
// agent of a running loop, the loop is no longer `running`, the orchestrator is told, and `start_loop`
// is accepted again (SC-006). Nothing real: a bare repository for the remote, the contractual fake `gh`
// over a JSON file, the fake CLI for the agents. The test commits in the worktrees itself.
//
// sc.1 is GREEN already, as far as the follow is concerned (`resume()` of DeliveryService exists since
// phase 4): it guards SC-005 on the real app. It becomes the proof that T052 does not break the restart
// (the quit of the app must not be taken for a closing of the agents by the user).
// sc.3 is RED until T052: the loop stays `running` for ever and `start_loop` is refused.
//
// Assumed, as in us51-auto-merge.spec.ts: the switch is `role="switch"` named « Auto » (ui.md), the CI
// is read every 30 s at most (PACT_CI_POLL_MS, if honoured in test mode, only makes it faster), the
// notice to the orchestrator for the end of a loop is an item of its list « Rapports » naming the issue.

let root: string;
let repo: string;
let bare: string;
let ghState: string;
let ghLog: string;
let ghChecks: string;
let launched: LaunchedApp | undefined;

const ISSUE = '0012-connexion';
const REMOTE = 'https://github.com/pact/e2e';
const TESTS = 'export const t = 1;\n';
const RUNNING = [{ id: 11, name: 'ci', status: 'in_progress', conclusion: null }];
const GREEN = [{ id: 11, name: 'ci', status: 'completed', conclusion: 'success' }];

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us55-', { 'README.md': '# test\n' }));
  bare = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', 'origin', 'main');
  ghState = join(root, 'gh-state.json');
  ghLog = join(root, 'gh.log');
  ghChecks = join(root, 'gh-checks.json');
  await writeFile(ghChecks, '{}');
  await writeFile(
    ghState,
    JSON.stringify({ remote: REMOTE, gitRemote: bare, prs: {}, required: ['ci'] }),
  );
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const env = () => ({
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  PACT_FAKE_GH: FAKE_GH,
  FAKE_GH_STATE: ghState,
  FAKE_GH_LOG: ghLog,
  FAKE_GH_CHECKS: ghChecks,
  PACT_CI_POLL_MS: '2000',
  FAKE_CLI_SCENARIO: scenarioPath('delivery-auto'),
});

const ghCalls = async (): Promise<string[][]> =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

const forge = async () =>
  JSON.parse(await readFile(ghState, 'utf8')) as {
    prs: Record<string, Record<string, unknown>>;
    merges?: { number: number; mode: string; head: string }[];
  };

/** The checks of `sha` on the forge, swapped atomically: the app reads this file while we write it. */
async function setChecks(sha: string, checks: typeof RUNNING | typeof GREEN) {
  const next = `${ghChecks}.next`;
  await writeFile(next, JSON.stringify({ [sha]: checks }));
  await rename(next, ghChecks);
}

const mergeCalls = async () => (await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'merge');
const createCalls = async () => (await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'create');
const checkReads = async () =>
  (await ghCalls()).filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;

/** The saved workspace: what a restart would find. */
async function saved(): Promise<{
  loops: { state: string; issueId: string }[];
  issues: { id: string; state: string }[];
  deliveries: { state: string }[];
}> {
  const dir = join(launched?.userDataDir ?? '', 'workspaces');
  const [file] = await readdir(dir);
  const text = await readFile(join(dir, file ?? ''), 'utf8');
  return (JSON.parse(text) as { data: never }).data;
}

/** Opens the repository, writes a ready issue and the test command into the saved workspace, relaunches. */
async function openWithIssue(): Promise<Page> {
  launched = await launchApp({ env: env() });
  let page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('button', { name: /Ajouter des agents/ })).toBeVisible();
  const userDataDir = launched.userDataDir;
  await launched.close({ keepData: true });

  const dir = join(userDataDir, 'workspaces');
  const [file] = await readdir(dir);
  const path = join(dir, file ?? '');
  const content = JSON.parse(await readFile(path, 'utf8')) as { data: Record<string, unknown> };
  const issue = {
    id: ISSUE,
    title: 'Connexion',
    path: `.pact/issues/${ISSUE}.md`,
    state: 'ready',
    remote: null,
    trace: { branch: null, agents: [], pr: null },
  };
  await writeFile(
    path,
    JSON.stringify({
      ...content,
      data: { ...content.data, issues: [issue], testCommand: 'git --version' },
    }),
  );
  launched = await launchApp({ userDataDir, env: env() });
  page = await launched.app.firstWindow();
  return page;
}

/** An orchestrator, a dev and `testers` testers, from the detailed launcher. */
async function launchTeam(page: Page, testers = 1) {
  const count = 2 + testers;
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = quick
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: /^Ajouter un / });
  for (let i = 1; i < count; i++) await plus.click();
  await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
  const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
  const agents = detailed.getByRole('list', { name: 'Agents' }).getByRole('listitem');
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
  const pick = (n: number) =>
    agents
      .nth(n)
      .getByRole('button', { name: /^Faux CLI/ })
      .click();
  await pick(0);
  await inspector.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await pick(1);
  await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('dev');
  for (let n = 2; n < count; n++) {
    await pick(n);
    await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('test');
  }
  await detailed.getByRole('button', { name: `Lancer ${String(count)} agents` }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = (n: number) =>
    page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
  const tiles = Array.from({ length: count }, (_, i) => tile(i + 1));
  for (const t of tiles) await expect(t).toHaveAttribute('data-state', 'awaiting-prompt');
  return { lead: tile(1), dev: tile(2), tester: tile(3), tile };
}

const call = (page: Page, lead: Locator, tool: string, args: Record<string, unknown>) =>
  typeIn(page, lead, `${tool}|${JSON.stringify(args)}`);

/** What the agents would have done: tests committed by the tester, then by the dev, with the code. */
async function work() {
  const devTree = agentWorktree(repo, 2);
  const testTree = agentWorktree(repo, 3);
  await mkdir(join(testTree, 'tests'), { recursive: true });
  await writeFile(join(testTree, 'tests', 'connexion.test.ts'), TESTS);
  git(testTree, 'add', '-A');
  git(testTree, 'commit', '-m', 'test: connexion');
  await mkdir(join(devTree, 'tests'), { recursive: true });
  await mkdir(join(devTree, 'src'), { recursive: true });
  await writeFile(join(devTree, 'tests', 'connexion.test.ts'), TESTS);
  await writeFile(join(devTree, 'src', 'connexion.ts'), 'export const connexion = 1;\n');
  git(devTree, 'add', '-A');
  git(devTree, 'commit', '-m', 'feat: connexion');
}

async function setAuto(page: Page, on: boolean) {
  const auto = page.getByRole('switch', { name: /Auto/ });
  await expect(auto).toBeEnabled();
  if ((await auto.getAttribute('aria-checked')) !== String(on)) await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', String(on));
}

/** The loop started by the orchestrator, as in us51 / us33. */
async function startLoop(page: Page, lead: Locator, tester: Locator, testerName = 'Faux CLI 3') {
  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: testerName });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await expect(tester).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
}

test('US6 sc.1, SC-005: PACT restarts while the CI of a PR runs, the follow goes on, one PR, and the green CI merges ONCE', async () => {
  test.setTimeout(420_000);
  const page = await openWithIssue();
  const { lead, tester } = await launchTeam(page);
  await setAuto(page, true);
  await work();
  await startLoop(page, lead, tester);
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText(
    `${ISSUE} : tests passés par PACT`,
    { timeout: 60_000 },
  );
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  await call(page, lead, 'request_delivery', {
    issue: ISSUE,
    title: 'Connexion par e-mail',
    message: 'feat: connexion',
  });
  await expect
    .poll(async () => Object.keys((await forge()).prs), { timeout: 90_000 })
    .toEqual(['1']);
  const head = String((await forge()).prs['1']?.headRefOid);
  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads);
  await expect
    .poll(async () => (await saved()).deliveries[0]?.state, { timeout: 30_000 })
    .toBe('watching');

  // PACT quits while the CI runs, and starts again on the same data.
  const userDataDir = launched?.userDataDir ?? '';
  await launched?.close({ keepData: true });
  launched = await launchApp({ userDataDir, env: env() });
  const again = await launched.app.firstWindow();
  await expect(again.getByRole('switch', { name: /Auto/ })).toHaveAttribute('aria-checked', 'true');

  // The follow resumes by itself: the checks are read again, nothing is created, nothing is merged.
  const afterRestart = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(afterRestart + 1);
  expect(Object.keys((await forge()).prs)).toEqual(['1']);
  expect(await createCalls()).toHaveLength(1);
  expect(await mergeCalls()).toHaveLength(0);
  expect((await saved()).deliveries[0]?.state).toBe('watching');
  // Quitting is not the user closing the agents: the loop and the request are as they were.
  expect((await saved()).loops[0]?.state).toBe('delivering');

  // The CI turns green: one merge, that commit, and not a second one.
  await setChecks(head, GREEN);
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  await expect
    .poll(async () => (await saved()).deliveries[0]?.state, { timeout: 30_000 })
    .toBe('merged');
  const settled = await checkReads();
  await expect.poll(checkReads, { timeout: 30_000 }).toBeGreaterThanOrEqual(settled);
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  expect((await forge()).merges).toEqual([{ number: 1, mode: 'squash', head }]);
  expect(await createCalls()).toHaveLength(1);
});

test('US6 sc.3, 4, SC-006: the user closes the tester of a running loop, the loop is no longer running, the orchestrator is told, start_loop is accepted again', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { lead, tester, tile } = await launchTeam(page, 2);
  await startLoop(page, lead, tester);
  await expect.poll(async () => (await saved()).loops[0]?.state).toBe('running');
  const reports = lead.getByRole('list', { name: 'Rapports' });
  await expect(reports.getByRole('listitem').filter({ hasText: ISSUE })).toHaveCount(0);

  // The user closes the tester by the tile, as anyone does.
  await tester.getByRole('button', { name: 'Fermer l’agent' }).click();
  const closing = page.getByRole('dialog', { name: 'Fermer Faux CLI 3' });
  await closing.getByRole('button', { name: 'Fermer l’agent' }).click();
  await expect(tester).toHaveCount(0);

  // sc.3: the loop is not `running` any more and the issue is free; the orchestrator hears of it.
  await expect
    .poll(async () => (await saved()).loops[0]?.state, { timeout: 30_000 })
    .toBe('closed');
  expect((await saved()).issues.find((i) => i.id === ISSUE)?.state).toBe('ready');
  await expect(reports.getByRole('listitem').filter({ hasText: ISSUE })).not.toHaveCount(0, {
    timeout: 30_000,
  });

  // sc.4: the orchestrator starts the loop again with the other tester, and is not refused.
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 4' });
  await expect
    .poll(async () => (await saved()).loops[0]?.state, { timeout: 30_000 })
    .toBe('running');
  expect((await saved()).issues.find((i) => i.id === ISSUE)?.state).toBe('in-progress');
  await expect(tile(4)).toBeVisible();
});
