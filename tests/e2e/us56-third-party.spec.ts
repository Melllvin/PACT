import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, outputOf, typeIn } from './helpers/workspace';

// 008 US7 end to end (T033): a public repository gives no hold (sc.1, 3, SC-009). Nothing real: the remote is a bare repository on the disk, `gh` is the contractual fake
// (tests/fixtures/fake-cli/fake-gh.mjs) over a JSON file, the agents are the fake CLI. The test commits
// in the worktrees itself, as the agents would, and DRIVES THE CI: the checks of the fake `gh` come
// from FAKE_GH_CHECKS, a file the test rewrites atomically (running, then green), and the state file
// requires the check « ci », so that a head with no check is « pending », never green.
//
// Assumed (as in us51): the switch is
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
const STRANGER = 'f'.repeat(40);
const WITNESS = 'PACT-INJECTION-WITNESS';
const GREEN = [{ id: 11, name: 'ci', status: 'completed', conclusion: 'success' }];

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us56-', { 'README.md': '# test\n' }));
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
    JSON.stringify({
      remote: REMOTE,
      gitRemote: bare,
      prs: {},
      required: ['ci'],
      scenario: 'third-party',
    }),
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
  FAKE_CLI_SCENARIO: scenarioPath('third-party'),
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
  // The CI of the third-party PRs is green all along: the bait of sc.3.
  await writeFile(next, JSON.stringify({ [STRANGER]: GREEN, [sha]: checks }));
  await rename(next, ghChecks);
}

const mergeCalls = async () => (await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'merge');
const checkReads = async () =>
  (await ghCalls()).filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;

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
  const plus = quick
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: /^Ajouter un / });
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
    // The fake gh adds the third-party PRs 900 and 901 beside PACT's own (scenario third-party).
    .poll(async () => Object.keys((await forge()).prs).filter((n) => Number(n) < 900), {
      timeout: 90_000,
    })
    .toEqual(['1']);
  const head = String((await forge()).prs['1']?.headRefOid);
  return { lead, dev, tester, head };
}

test('US7 sc.1, 3, SC-009: with a fork PR and a PR of another author full of injections and green, a delivery with Auto on merges only PACT’s own PR, and the witness reaches no agent, no screen, no file', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { lead, dev, tester, head } = await deliver(page, true);

  // What the three fake agents printed so far (they echo every prompt they are typed).
  const before = await Promise.all([1, 2, 3].map((n) => outputOf(page, n)));

  await setChecks(head, RUNNING);
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 120_000 }).toBeGreaterThan(reads + 1);
  await setChecks(head, GREEN);
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  await expect(dev).toHaveCount(0, { timeout: 60_000 });
  await expect(tester).toHaveCount(0);

  const after = await Promise.all([1, 2, 3].map((n) => outputOf(page, n)));
  const prs = (await forge()).prs;

  // sc.3: the third-party PRs are open, green, and untouched; only PR 1 was merged.
  expect((await forge()).merges).toEqual([{ number: 1, mode: 'squash', head }]);
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  expect(prs['900']?.state).toBe('OPEN');
  expect(prs['901']?.state).toBe('OPEN');
  const calls = await ghCalls();
  const aimed = calls.filter((args) =>
    args.some((arg) => /(^|\/)(900|901)$/.test(arg) || arg.includes(STRANGER)),
  );
  expect(aimed).toEqual([]);
  expect(calls.flat().some((arg) => arg.includes('refs/pull') || arg.includes('--auto'))).toBe(
    false,
  );
  expect(
    calls.some(([a, b]) => (a === 'pr' && b === 'list') || a === 'search' || b === 'search'),
  ).toBe(false);

  // SC-009: not one agent was typed the witness, nothing on screen carries it, nothing is saved with it.
  for (const text of [...before, ...after]) expect(text).not.toContain(WITNESS);
  expect(await lead.textContent()).not.toContain(WITNESS);
  expect(await page.content()).not.toContain(WITNESS);
  expect(await page.locator('body').innerText()).not.toContain(WITNESS);
  const dir = join(launched?.userDataDir ?? '', 'workspaces');
  for (const file of await readdir(dir)) {
    // The app writes `<id>.json.<pid>.<n>.tmp` then renames it: a temporary file listed here may be
    // gone when read (ENOENT); its content is then in the final file, which is listed and read too.
    const text = await readFile(join(dir, file), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    expect(text).not.toContain(WITNESS);
  }
  // sc.8: the remote exposes no ref of PR to the repository of the user.
  expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/pull')).toBe('');
});
