import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US3 end to end (T038): read, Validate or Refuse (sc.2, 4, 5, 7, SC-007). Nothing real: the remote
// is a bare repository on the disk, `gh` is the contractual fake (tests/fixtures/fake-cli/fake-gh.mjs)
// over a JSON file, the agents are the fake CLI (scenario `delivery-review`). The test commits in the
// worktrees itself, as the agents would, and DRIVES THE CI through FAKE_GH_CHECKS, rewritten atomically;
// the state file requires the check « ci », so that a head with no check is « pending », never green.
// Auto is OFF in these tests unless a scenario says otherwise.
//
// RED until T039 and T040 (`delivery:decide` on a PR of the forge, the buttons of the item). Assumed
// (tests/unit/renderer/todo/TodoItem.test.tsx): the item « Relire la PR #1 » has the buttons « Valider »
// and « Refuser »; « Refuser » opens a field named « motif » and, once it is filled, the button
// « Refuser » of the item sends it.

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
  ({ root, repo } = await createRepo('pact-us52-', { 'README.md': '# test\n' }));
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
  FAKE_CLI_SCENARIO: scenarioPath('delivery-review'),
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
async function setChecks(sha: string, checks: typeof GREEN) {
  const next = `${ghChecks}.next`;
  await writeFile(next, JSON.stringify({ [sha]: checks }));
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
    .poll(async () => Object.keys((await forge()).prs), { timeout: 90_000 })
    .toEqual(['1']);
  const head = String((await forge()).prs['1']?.headRefOid);
  return { lead, dev, tester, head };
}

/** The saved workspace, with the journal of 007: what a restart would find. */
async function savedAll(): Promise<{
  loops: { state: string; round: number }[];
  issues: { id: string; state: string }[];
  delivery: { auto: boolean };
  agents: { id: string; role: string }[];
  exchanges: { messages: { to: string; kind: string; text: string; unreadBy: string[] }[] };
}> {
  const dir = join(launched?.userDataDir ?? '', 'workspaces');
  const [file] = await readdir(dir);
  const text = await readFile(join(dir, file ?? ''), 'utf8');
  return (JSON.parse(text) as { data: never }).data;
}

const reviewItem = (page: Page) =>
  page.getByRole('listitem').filter({ hasText: 'Relire la PR #1' });

/** Waits for a loop `accepted` in the saved workspace (the tester's report, then PACT's proof). */
async function acceptedAgain() {
  await expect
    .poll(async () => (await savedAll()).loops[0]?.state, { timeout: 90_000 })
    .toBe('accepted');
  // PACT wakes the orchestrator 5 s after the proof (« N événements, lis get_events »): a call typed into
  // its terminal before that pointer is read gets glued to it (« Outil inconnu »). Let the wake settle.
  await expect
    .poll(
      async () => {
        const state = await savedAll();
        const lead = state.agents.find((a) => a.role === 'orchestrator')?.id ?? '';
        // -1 while the word of the proof has not reached the orchestrator yet.
        if (!state.exchanges.messages.some((m) => m.to === lead && m.text.includes('au tour 2'))) {
          return -1;
        }
        return state.exchanges.messages.filter((m) => m.unreadBy.includes(lead)).length;
      },
      { timeout: 60_000 },
    )
    .toBe(0);
}

/** From a launched team to PR #1 open and its CI green: the item waits for the user. */
async function reviewing(page: Page, auto = false) {
  const delivered = await deliver(page, auto);
  await setChecks(delivered.head, GREEN);
  await expect(reviewItem(page)).toBeVisible({ timeout: 120_000 });
  return delivered;
}

test('US3 sc.2, SC-007: a double click on Valider merges once, with a single gesture and no dialog', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  const { dev, head } = await reviewing(page);
  // Auto is off and the CI is green: PACT asked, it did not merge.
  expect(await mergeCalls()).toHaveLength(0);

  await reviewItem(page).getByRole('button', { name: 'Valider' }).dblclick();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  expect((await forge()).merges).toEqual([{ number: 1, mode: 'squash', head }]);
  await expect(reviewItem(page)).toHaveCount(0);
  await expect(dev).toHaveCount(0, { timeout: 60_000 });
  expect((await ghCalls()).flat().some((arg) => arg.includes('--auto'))).toBe(false);
});

test('US3 sc.4: Refuser with a reason sends it to the dev as a defect, counts a round and leaves the PR open', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();
  await reviewing(page);
  const reason = 'Le champ e-mail accepte une chaine vide.';

  const item = reviewItem(page);
  await item.getByRole('button', { name: 'Refuser' }).click();
  await item.getByRole('textbox', { name: /motif/i }).fill(reason);
  await item.getByRole('button', { name: 'Refuser' }).click();

  await expect(reviewItem(page)).toHaveCount(0, { timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const saved = await savedAll();
        return {
          round: saved.loops[0]?.round,
          sent: saved.exchanges.messages.some(
            (m) => m.kind === 'verdict' && m.text.includes(reason),
          ),
        };
      },
      { timeout: 60_000 },
    )
    .toEqual({ round: 2, sent: true });
  expect((await forge()).prs['1']?.state).toBe('OPEN');
  expect(await mergeCalls()).toHaveLength(0);
});

test('US3 sc.5: after a refusal and a new green CI, the item comes back once, even with Auto turned on meanwhile', async () => {
  test.setTimeout(420_000);
  const page = await openWithIssue();
  const { lead, head } = await reviewing(page);
  const item = reviewItem(page);
  await item.getByRole('button', { name: 'Refuser' }).click();
  await item.getByRole('textbox', { name: /motif/i }).fill('Ajoute le cas vide.');
  await item.getByRole('button', { name: 'Refuser' }).click();
  await expect(reviewItem(page)).toHaveCount(0, { timeout: 60_000 });

  // The dev fixes it, the tester accepts again, Auto is turned on, the same gesture is made again.
  const devTree = agentWorktree(repo, 2);
  await writeFile(join(devTree, 'src', 'vide.ts'), 'export const vide = 1;\n');
  git(devTree, 'add', '-A');
  git(devTree, 'commit', '-m', 'fix: cas vide');
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await acceptedAgain();
  await setAuto(page, true);
  await call(page, lead, 'request_delivery', {
    issue: ISSUE,
    title: 'Connexion par e-mail',
    message: 'fix: cas vide',
  });
  await expect
    .poll(async () => (await forge()).prs['1']?.headRefOid, { timeout: 90_000 })
    .not.toBe(head);
  expect(Object.keys((await forge()).prs)).toEqual(['1']);
  const next = String((await forge()).prs['1']?.headRefOid);

  await setChecks(next, GREEN);

  await expect(reviewItem(page)).toBeVisible({ timeout: 120_000 });
  const after = await checkReads();
  await expect.poll(checkReads, { timeout: 60_000 }).toBeGreaterThan(after);
  expect(await mergeCalls()).toHaveLength(0);
  await expect(reviewItem(page)).toHaveCount(1);

  await reviewItem(page).getByRole('button', { name: 'Valider' }).click();
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', next],
  ]);
});

test('US3 sc.7: a PR without a verdict, Auto on and a green CI, is not merged: it asks for a review, and Valider merges it without closing the agent', async () => {
  test.setTimeout(300_000);
  launched = await launchApp({ env: env() });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  await page
    .getByRole('dialog', { name: 'Ajouter au workspace' })
    .getByRole('button', { name: 'Lancer 1 agent' })
    .click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const tile = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  const tree = agentWorktree(repo, 1);
  await writeFile(join(tree, 'seul.ts'), 'export const s = 1;\n');
  git(tree, 'add', '-A');
  git(tree, 'commit', '-m', 'feat: seul');
  await setAuto(page, true);

  await tile.getByRole('button', { name: 'Créer la PR sans verdict' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Message' }).fill('feat: seul');
  await dialog.getByRole('button', { name: 'Demander' }).click();
  await expect
    .poll(async () => Object.keys((await forge()).prs), { timeout: 90_000 })
    .toEqual(['1']);
  const head = String((await forge()).prs['1']?.headRefOid);
  await setChecks(head, GREEN);

  await expect(reviewItem(page)).toContainText('sans verdict', { timeout: 120_000 });
  const reads = await checkReads();
  await expect.poll(checkReads, { timeout: 60_000 }).toBeGreaterThan(reads);
  expect(await mergeCalls()).toHaveLength(0);
  expect((await forge()).prs['1']?.state).toBe('OPEN');

  await reviewItem(page).getByRole('button', { name: 'Valider' }).click();
  await expect
    .poll(async () => (await forge()).prs['1']?.state, { timeout: 120_000 })
    .toBe('MERGED');
  expect(await mergeCalls()).toEqual([
    ['pr', 'merge', '1', '--squash', '--match-head-commit', head],
  ]);
  // FR-039: no worktree removed, the agent stays.
  await expect(tile).toBeVisible();
  expect(existsSync(tree)).toBe(true);
});
