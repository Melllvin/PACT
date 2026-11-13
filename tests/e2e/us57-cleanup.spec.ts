import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US8 end to end (T064): the worktrees no longer pile up. sc.1 and SC-011: a PR merged by Auto, a dev
// clean on the head with a node_modules: its worktree and its branch are gone from the disk, and so is the
// tester's worktree; the orchestrator's stays. sc.2 and sc.3: the same with a file the dev never committed
// (written once the PR is open): nothing is removed, À faire shows « Worktree gardé » with « Supprimer
// quand même », the click lists what would be lost in a confirmation and deletes nothing, and only the
// confirmation deletes. Nothing real: the remote is a bare repository on the disk, `gh` is the contractual
// fake over a JSON file, the agents are the fake CLI; the test commits in the worktrees itself, as the
// agents would, and drives the CI through FAKE_GH_CHECKS.
//
// RED until the cleanup exists (T065, T066). Assumed, as in us51-auto-merge.spec.ts: the switch is
// `role="switch"` named « Auto », the CI is read every 30 s at most (PACT_CI_POLL_MS, if honoured, only
// makes it faster). The element is a listitem of À faire that reads « Worktree gardé »; the confirmation
// is a `dialog` named « Supprimer quand même » with the buttons « Supprimer » and « Annuler » (TodoItem.test.tsx).

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
const GREEN = [{ id: 11, name: 'ci', status: 'completed', conclusion: 'success' }];

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us57-', { 'README.md': '# test\n' }));
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
  FAKE_CLI_SCENARIO: scenarioPath('delivery-cleanup'),
});

const forge = async () =>
  JSON.parse(await readFile(ghState, 'utf8')) as {
    prs: Record<string, Record<string, unknown>>;
    merges?: { number: number; mode: string; head: string }[];
  };

/** The checks of `sha` on the forge, swapped atomically: the app reads this file while we write it. */
async function setChecks(sha: string, checks: typeof GREEN) {
  const next = `${ghChecks}.next`;
  await writeFile(next, JSON.stringify({ [sha]: checks }));
  await rename(next, ghChecks);
}

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
    .poll(async () => Object.keys((await forge()).prs), { timeout: 90_000 })
    .toEqual(['1']);
  const head = String((await forge()).prs['1']?.headRefOid);
  return { lead, dev, tester, head };
}

/** Where the three agents live, and the branch of the dev, taken before anything is merged. */
function places() {
  const lead = agentWorktree(repo, 1);
  const dev = agentWorktree(repo, 2);
  const tester = agentWorktree(repo, 3);
  const branch = git(dev, 'rev-parse', '--abbrev-ref', 'HEAD');
  return { lead, dev, tester, branch };
}
const branchExists = (branch: string) => git(repo, 'branch', '--list', branch) !== '';
const merged = async () => (await forge()).prs['1']?.state;

test('US8 sc.1, SC-011: a PR merged by Auto, a dev clean on its head with a node_modules: its worktree and its branch are gone, and so is the tester’s; the orchestrator’s stays', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { head } = await deliver(page, true);
  const where = places();
  // An ignored node_modules in the worktree of the dev: it goes with the folder, it is no reason to keep it.
  await mkdir(join(where.dev, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(where.dev, 'node_modules', 'pkg', 'index.js'), 'x\n');
  await writeFile(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n', { flag: 'a' });
  expect(existsSync(where.dev)).toBe(true);

  await setChecks(head, GREEN);
  await expect.poll(merged, { timeout: 120_000 }).toBe('MERGED');

  // SC-011: no worktree of the dev and the tester is left on the disk, with no gesture of the user.
  await expect.poll(() => existsSync(where.dev), { timeout: 60_000 }).toBe(false);
  await expect.poll(() => existsSync(where.tester), { timeout: 60_000 }).toBe(false);
  expect(branchExists(where.branch)).toBe(false);
  const listed = git(repo, 'worktree', 'list', '--porcelain');
  expect(listed).not.toContain(where.dev);
  expect(listed).not.toContain(where.tester);
  // The orchestrator is never touched.
  expect(existsSync(where.lead)).toBe(true);
  expect(listed).toContain(where.lead);
  // Not one `--force`: the removal that PACT did is the plain one (the forge saw only the merge).
  expect((await saved()).issues.find((i) => i.id === ISSUE)?.state).toBe('done');
  await expect(page.getByRole('listitem').filter({ hasText: 'Worktree gardé' })).toHaveCount(0);
});

test('US8 sc.2, 3: a dev with a file it never committed: nothing is removed, À faire says so, « Supprimer quand même » lists what would be lost and deletes only once confirmed', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { head } = await deliver(page, true);
  const where = places();
  // Written once the PR is open: the request was accepted on a clean worktree, the merge finds this file.
  await writeFile(join(where.dev, 'notes.txt'), 'à garder\n');

  await setChecks(head, GREEN);
  await expect.poll(merged, { timeout: 120_000 }).toBe('MERGED');

  // sc.2: the tester, clean and contained, goes; the dev stays with its file and its branch, and À faire says why.
  await expect.poll(() => existsSync(where.tester), { timeout: 60_000 }).toBe(false);
  const item = page.getByRole('listitem').filter({ hasText: 'Worktree gardé' });
  await expect(item).toBeVisible({ timeout: 60_000 });
  await expect(item).toContainText('notes.txt');
  expect(existsSync(join(where.dev, 'notes.txt'))).toBe(true);
  expect(branchExists(where.branch)).toBe(true);

  // sc.3: the click says what would be lost BEFORE deleting anything.
  await item.getByRole('button', { name: 'Supprimer quand même' }).click();
  const dialog = page.getByRole('dialog', { name: /Supprimer quand même/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('notes.txt');
  expect(existsSync(join(where.dev, 'notes.txt'))).toBe(true);

  // Cancelling deletes nothing.
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  expect(existsSync(join(where.dev, 'notes.txt'))).toBe(true);

  // Confirming deletes the worktree and the branch, and the item goes.
  await item.getByRole('button', { name: 'Supprimer quand même' }).click();
  await page
    .getByRole('dialog', { name: /Supprimer quand même/ })
    .getByRole('button', { name: 'Supprimer' })
    .click();
  await expect.poll(() => existsSync(where.dev), { timeout: 60_000 }).toBe(false);
  // The branch goes right after the directory (cleanup.force): wait for it, do not race it.
  await expect.poll(() => branchExists(where.branch), { timeout: 30_000 }).toBe(false);
  await expect(item).toHaveCount(0);
  // The orchestrator, again, is untouched.
  expect(existsSync(where.lead)).toBe(true);
});
