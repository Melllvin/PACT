import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US1 end to end (T017): from an accepted loop to the pull request, with no gesture of the
// user (SC-003), and the actions of a lone agent (sc.11). Nothing real: the remote is a bare
// repository on the disk, `gh` is the contractual fake (tests/fixtures/fake-cli/fake-gh.mjs) over a
// JSON file, the agents are the fake CLI. The test commits in the worktrees itself, as the agents
// would; the fake CLI only reports.
//
// RED until DeliveryService, the tool `request_delivery` and the delivery actions exist (T018 to
// T022). Assumed: the actions « Livrer » and « Créer la PR sans verdict » are buttons of the
// agent’s tile (`article`), the dialog that follows has « Titre », « Message » and « Demander ».

let root: string;
let repo: string;
let bare: string;
let ghState: string;
let ghLog: string;
let launched: LaunchedApp | undefined;

const ISSUE = '0012-connexion';
const REMOTE = 'https://github.com/pact/e2e';
const TESTS = 'export const t = 1;\n';

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us50-', { 'README.md': '# test\n' }));
  bare = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', 'origin', 'main');
  ghState = join(root, 'gh-state.json');
  ghLog = join(root, 'gh.log');
  await writeFile(ghState, JSON.stringify({ remote: REMOTE, gitRemote: bare, prs: {} }));
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
  FAKE_CLI_SCENARIO: scenarioPath('delivery-pr'),
});

const ghCalls = async (): Promise<string[][]> =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

const prs = async () =>
  (JSON.parse(await readFile(ghState, 'utf8')) as { prs: Record<string, Record<string, unknown>> })
    .prs;

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
  const saved = JSON.parse(await readFile(path, 'utf8')) as { data: Record<string, unknown> };
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
      ...saved,
      data: { ...saved.data, issues: [issue], testCommand: 'git --version' },
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
  return { devTree, branch: git(devTree, 'rev-parse', '--abbrev-ref', 'HEAD') };
}

/** A colleague pushes to main: origin/main is ahead of the root of the dev (sc.5). */
async function colleaguePushes() {
  const clone = join(root, 'colleague');
  git(root, 'clone', bare, clone);
  git(clone, 'config', 'user.name', 'Colleague');
  git(clone, 'config', 'user.email', 'colleague@pact.test');
  await writeFile(join(clone, 'COLLEGUE.md'), '# collègue\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'colleague work');
  git(clone, 'push', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

test('US1 sc.1, 5, SC-003: a refused request, then an accepted loop becomes a pull request on an up-to-date branch, with no gesture', async () => {
  test.setTimeout(240_000);
  const page = await openWithIssue();
  const { lead, tester } = await launchTeam(page);
  const { branch } = await work();
  const colleague = await colleaguePushes();

  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée`, { timeout: 30_000 });
  await expect(lead).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });

  // sc.1: the loop has no accepted verdict yet. Refused, with the reason; nothing leaves.
  const request = { issue: ISSUE, title: 'Connexion par e-mail', message: 'feat: connexion' };
  await call(page, lead, 'request_delivery', request);
  await expect(lead).toContainText('n’est pas acceptée', { timeout: 30_000 });
  expect(await ghCalls()).not.toContainEqual(expect.arrayContaining(['pr', 'create']));
  expect(() => git(bare, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow();

  // The test accepts: PACT runs the tests itself and the loop is accepted.
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText(
    `${ISSUE} : tests passés par PACT`,
    { timeout: 60_000 },
  );
  await expect(tester).not.toHaveAttribute('data-state', 'working');
  await expect(lead).not.toHaveAttribute('data-state', 'working');

  // The request: from here, not one click (SC-003).
  await call(page, lead, 'request_delivery', request);
  await expect(lead).toContainText('MCP request_delivery :', { timeout: 30_000 });
  await expect.poll(async () => Object.keys(await prs()), { timeout: 90_000 }).toEqual(['1']);

  const opened = (await prs())['1'];
  expect(opened).toMatchObject({
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: branch,
    title: 'Connexion par e-mail',
  });
  // The branch on the remote is the dev’s work on top of what the colleague pushed (sc.5).
  const pushed = git(bare, 'rev-parse', `refs/heads/${branch}`);
  expect(opened?.headRefOid).toBe(pushed);
  expect(() => git(bare, 'merge-base', '--is-ancestor', colleague, pushed)).not.toThrow();
  expect(git(bare, 'log', '-1', '--format=%s', pushed)).toContain('connexion');
  // main on the remote is the colleague’s: PACT merged nothing.
  expect(git(bare, 'rev-parse', 'refs/heads/main')).toBe(colleague);
  // The calls of gh: a PR created, never with --auto, never a pull ref.
  const calls = await ghCalls();
  expect(calls.filter(([a, b]) => a === 'pr' && b === 'create')).toHaveLength(1);
  expect(calls.flat().some((arg) => arg.includes('--auto') || arg.includes('refs/pull'))).toBe(
    false,
  );
  // Nothing was asked of the user to get here.
  await expect(page.getByRole('listitem').filter({ hasText: '◎ Fusionner' })).toHaveCount(0);
});

test('US1 sc.11: a lone agent with a remote cannot « Livrer »; « Créer la PR sans verdict » asks for a review even so', async () => {
  test.setTimeout(150_000);
  launched = await launchApp({ env: env() });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: '+' })
    .click();
  await launcher.getByRole('button', { name: 'Lancer 1 agent' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  const tree = agentWorktree(repo, 1);
  await writeFile(join(tree, 'seul.ts'), 'export const s = 1;\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-m', 'feat: seul');

  const livrer = tile.getByRole('button', { name: 'Livrer' });
  await expect(livrer).toBeDisabled();
  await tile.getByRole('button', { name: 'Créer la PR sans verdict' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Message' }).fill('feat: seul');
  await dialog.getByRole('button', { name: 'Demander' }).click();

  await expect.poll(async () => Object.keys(await prs()), { timeout: 90_000 }).toEqual(['1']);
  const todo = page.getByRole('listitem').filter({ hasText: 'Relire la PR #1' });
  await expect(todo).toContainText('sans verdict');
  expect((await ghCalls()).flat().some((arg) => arg.includes('--auto'))).toBe(false);
});
