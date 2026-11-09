import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US4 end to end (T043): a CI absent, silent or red (sc.1, 2, 3, 5). Nothing real: the remote is a bare
// repository on the disk, `gh` is the contractual fake (tests/fixtures/fake-cli/fake-gh.mjs) over a JSON
// file, the agents are the fake CLI (scenario delivery-ci, the one of delivery-auto: the agents only
// answer the prompts of the test). The test commits in the worktrees itself, as the agents would, and DRIVES
// THE CI through FAKE_GH_CHECKS and the state file of the forge (required checks, mergeStateStatus).
//
// RED until the silent CI, the red CI to the dev and the rebase after the PR exist (T044, T045). Assumed:
// the CI is read every 2 s (PACT_CI_POLL_MS) and, in test mode, the silence of a configured CI counts
// from PACT_SILENT_CI_MS (6 s here) instead of 10 minutes; the item « CI muette · PR #<n> » offers
// « Attendre encore » and « Relire » (ui.md); the fake `gh` settles BEHIND when the branch moves.

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
type RawCheck = { id: number; name: string; status: string; conclusion: string | null };
const RUNNING: RawCheck[] = [{ id: 11, name: 'ci', status: 'in_progress', conclusion: null }];
const GREEN: RawCheck[] = [{ id: 11, name: 'ci', status: 'completed', conclusion: 'success' }];
const RED: RawCheck[] = [{ id: 11, name: 'ci', status: 'completed', conclusion: 'failure' }];

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us53-', { 'README.md': '# test\n' }));
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
  PACT_SILENT_CI_MS: '6000',
  FAKE_CLI_SCENARIO: scenarioPath('delivery-ci'),
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
async function setChecks(sha: string, checks: RawCheck[]) {
  const next = `${ghChecks}.next`;
  await writeFile(next, JSON.stringify({ [sha]: checks }));
  await rename(next, ghChecks);
}

const mergeCalls = async () => (await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'merge');
const checkReads = async () =>
  (await ghCalls()).filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;

/** The saved workspace: what a restart would find. */
async function saved(): Promise<{
  loops: { state: string; round: number }[];
  issues: { id: string; state: string }[];
  deliveries: {
    state: string;
    rebases: number;
    pushedHead: string | null;
    verdictCommit: string | null;
  }[];
  delivery: { auto: boolean };
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

/** An orchestrator, a dev and a test, from the detailed launcher. */
async function launchTeam(page: Page) {
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = quick.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' });
  await plus.click();
  await plus.click();
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
  await pick(2);
  await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption('test');
  await detailed.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  const dev = page.getByRole('article', { name: /^Faux CLI 2,/ });
  const tester = page.getByRole('article', { name: /^Faux CLI 3,/ });
  for (const tile of [lead, dev, tester]) {
    await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  }
  return { lead, dev, tester };
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

/** The switch « Auto » of the bar of the delivery (ui.md): put it on or off, as the user would. */
async function setAuto(page: Page, on: boolean) {
  const auto = page.getByRole('switch', { name: /Auto/ });
  await expect(auto).toBeEnabled();
  if ((await auto.getAttribute('aria-checked')) !== String(on)) await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', String(on));
}

/** From a launched team to PR #1 open: accepted loop, request, no gesture after it. */
async function deliver(page: Page, auto: boolean) {
  const { lead, dev, tester } = await launchTeam(page);
  await setAuto(page, auto);
  await work();
  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText(
    `${ISSUE} : tests passés par PACT`,
    { timeout: 60_000 },
  );
  await expect(tester).not.toHaveAttribute('data-state', 'working');
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
  return { lead, dev, tester, head };
}

/** The state of the forge, rewritten atomically: the app reads it while we write it. */
async function patchForge(change: (state: Record<string, unknown>) => void) {
  const state = JSON.parse(await readFile(ghState, 'utf8')) as Record<string, unknown>;
  change(state);
  const next = `${ghState}.next`;
  await writeFile(next, JSON.stringify(state));
  await rename(next, ghState);
}

const setRequired = (required: string[]) =>
  writeFile(ghState, JSON.stringify({ remote: REMOTE, gitRemote: bare, prs: {}, required }));

const todo = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text });

test('US4 sc.1: no workflow and no required check, Auto on: PACT merges after the verdict, with no check', async () => {
  test.setTimeout(300_000);
  await setRequired([]);
  const page = await openWithIssue();
  const { head } = await deliver(page, true);

  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');

  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  expect((await ghCalls()).flat().some((arg) => arg.includes('--auto'))).toBe(false);
});

test('US4 sc.1: no workflow and no required check, Auto off: PACT asks for a review and merges nothing', async () => {
  test.setTimeout(300_000);
  await setRequired([]);
  const page = await openWithIssue();
  const { dev } = await deliver(page, false);

  await expect(todo(page, 'Relire la PR #1')).toBeVisible({ timeout: 120_000 });

  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');
  await expect(dev).toBeVisible();
});

test('US4 sc.2: a configured CI that shows no check: after the silence PACT tells the user, offers « Attendre encore » and « Relire », and merges nothing, Auto or not', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  await deliver(page, true);

  const item = todo(page, 'CI muette · PR #1');
  await expect(item).toBeVisible({ timeout: 120_000 });
  await expect(item.getByRole('button', { name: 'Attendre encore' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Relire' })).toBeVisible();
  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');

  await item.getByRole('button', { name: 'Attendre encore' }).click();

  await expect(item).toHaveCount(0);
  expect(await mergeCalls()).toHaveLength(0);
  expect((await saved()).deliveries[0]?.state).toBe('watching');
});

test('US4 sc.3: a red check goes back to the dev: a round is counted, nothing is merged', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { dev, head } = await deliver(page, true);

  await setChecks(head, RED);

  await expect
    .poll(async () => (await saved()).deliveries[0]?.state, { timeout: 120_000 })
    .toBe('ci-red');
  expect((await saved()).loops[0]).toMatchObject({ state: 'running', round: 2 });
  await expect(dev).toContainText('« ci »', { timeout: 60_000 });
  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');
});

test('US4 sc.5: main moved and the PR is BEHIND: PACT brings it up to date, awaits a new CI, counts no round, and merges the new head once green', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { head } = await deliver(page, true);
  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads + 1);

  const colleague = join(root, 'colleague');
  git(root, 'clone', '-q', bare, colleague);
  await writeFile(join(colleague, 'NOTES.md'), 'main moves\n');
  git(colleague, 'add', '-A');
  git(
    colleague,
    '-c',
    'user.name=Colleague',
    '-c',
    'user.email=c@pact.dev',
    'commit',
    '-m',
    'main moves',
  );
  git(colleague, 'push', '-q', 'origin', 'main');
  await patchForge((state) => {
    const prs = state.prs as Record<string, Record<string, unknown>>;
    prs['1'] = { ...prs['1'], mergeStateStatus: 'BEHIND' };
  });

  await expect
    .poll(async () => (await saved()).deliveries[0]?.rebases, { timeout: 120_000 })
    .toBe(1);
  // The fake forge moves the head of the PR at the next call that reads it (the push is in the bare repo).
  await expect
    .poll(async () => String((await forge()).prs['1']?.headRefOid), { timeout: 30_000 })
    .not.toBe(head);
  const rebased = String((await forge()).prs['1']?.headRefOid);
  expect((await saved()).deliveries[0]?.pushedHead).toBe(rebased);
  expect((await saved()).loops[0]).toMatchObject({ state: 'delivering', round: 1 });
  expect(await mergeCalls()).toHaveLength(0);

  // The green of the old head is worth nothing: only the new head's CI decides.
  await setChecks(head, GREEN);
  const after = await checkReads();
  await expect.poll(checkReads, { timeout: 60_000 }).toBeGreaterThan(after + 1);
  expect(await mergeCalls()).toHaveLength(0);

  await setChecks(rebased, GREEN);
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', rebased],
  ]);
});
