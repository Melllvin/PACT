import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US2 end to end (T027): Auto merges what the CI validated, and nothing else (sc.1, 4, 5, 6, 7,
// SC-002). Nothing real: the remote is a bare repository on the disk, `gh` is the contractual fake
// (tests/fixtures/fake-cli/fake-gh.mjs) over a JSON file, the agents are the fake CLI. The test commits
// in the worktrees itself, as the agents would, and DRIVES THE CI: the checks of the fake `gh` come
// from FAKE_GH_CHECKS, a file the test rewrites atomically (running, then green), and the state file
// requires the check « ci », so that a head with no check is « pending », never green.
//
// RED until the CI watcher, the merge and the Auto switch exist (T028 to T030). Assumed: the switch is
// `role="switch"` named « Auto » (ui.md), the CI is read every 30 s (CI_POLL_MS: the timeouts allow
// it; PACT_CI_POLL_MS, if the dev honours it in test mode, only makes these tests faster), and a dev
// and a tester closed at the merge leave the Agents column.

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
  ({ root, repo } = await createRepo('pact-us51-', { 'README.md': '# test\n' }));
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
async function setChecks(sha: string, checks: (typeof RUNNING)[number][] | typeof GREEN) {
  const next = `${ghChecks}.next`;
  await writeFile(next, JSON.stringify({ [sha]: checks }));
  await rename(next, ghChecks);
}

const mergeCalls = async () => (await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'merge');
const checkReads = async () =>
  (await ghCalls()).filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;

/** The saved workspace: what a restart would find. */
async function saved(): Promise<{
  loops: { state: string }[];
  issues: { id: string; state: string }[];
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

test('US2 sc.1, 7, SC-002: Auto on, a CI that runs then turns green merges the head in the mode of the project, then closes the loop and the agents, and never uses --auto', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { dev, tester, head } = await deliver(page, true);

  // The CI runs: the checks are read, nothing is merged, nothing is closed (sc.7: not before).
  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads + 1);
  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');
  await expect(dev).toBeVisible();
  await expect(tester).toBeVisible();
  expect((await saved()).issues.find((i) => i.id === ISSUE)?.state).toBe('in-progress');

  // The CI turns green on the very commit of the PR: one merge, that commit, the squash of the project.
  await setChecks(head, GREEN);
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  expect((await forge()).merges).toEqual([{ number: 1, mode: 'squash', head }]);
  expect(git(bare, 'rev-parse', 'refs/heads/main')).not.toBe(git(repo, 'rev-parse', 'main'));

  // The loop is merged, the issue done, the dev and the tester gone from the column (sc.7).
  await expect(dev).toHaveCount(0, { timeout: 60_000 });
  await expect(tester).toHaveCount(0);
  await expect
    .poll(async () => (await saved()).issues.find((i) => i.id === ISSUE)?.state, {
      timeout: 30_000,
    })
    .toBe('done');
  expect((await saved()).loops[0]?.state).toBe('merged');

  // SC-002: not one `--auto`, not one pull ref, in all the calls of gh.
  const flat = (await ghCalls()).flat();
  expect(flat.some((arg) => arg.includes('--auto') || arg.includes('refs/pull'))).toBe(false);
});

test('US2 sc.4: Auto is off in a new project and what the user chose is kept after a restart', async () => {
  test.setTimeout(120_000);
  launched = await launchApp({ env: env() });
  let page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  await page
    .getByRole('dialog', { name: 'Ajouter au workspace' })
    .getByRole('button', { name: 'Lancer 1 agent' })
    .click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  await expect(page.getByRole('article', { name: /^Faux CLI 1,/ })).toBeVisible();

  const auto = page.getByRole('switch', { name: /Auto/ });
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  await setAuto(page, true);
  await expect.poll(async () => (await saved()).delivery.auto, { timeout: 30_000 }).toBe(true);

  const userDataDir = launched.userDataDir;
  await launched.close({ keepData: true });
  launched = await launchApp({ userDataDir, env: env() });
  page = await launched.app.firstWindow();

  await expect(page.getByRole('switch', { name: /Auto/ })).toHaveAttribute('aria-checked', 'true');
});

test('US2 sc.5: Auto off and a CI that runs, then Auto on and the CI green: PACT merges, because Auto is read when the CI turns green', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { head } = await deliver(page, false);
  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads + 1);
  expect(await mergeCalls()).toHaveLength(0);

  await setAuto(page, true);
  await setChecks(head, GREEN);

  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toHaveLength(1);
});

test('US2 sc.6: Auto on and a CI that runs, then Auto off and the CI green: PACT does not merge and asks for a review', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { dev, head } = await deliver(page, true);
  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads + 1);

  await setAuto(page, false);
  await setChecks(head, GREEN);

  const todo = page.getByRole('listitem').filter({ hasText: 'Relire la PR #1' });
  await expect(todo).toBeVisible({ timeout: 120_000 });
  // The CI is read again meanwhile: still nothing merged, the agents still there.
  const after = await checkReads();
  await expect.poll(checkReads, { timeout: 60_000 }).toBeGreaterThan(after);
  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');
  await expect(dev).toBeVisible();
  expect((await ghCalls()).flat().some((arg) => arg.includes('--auto'))).toBe(false);
});
