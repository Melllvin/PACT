import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, typeIn } from './helpers/workspace';

// 008 US5 end to end (T057): « Peaufiner sans ajouter » (sc.2, 3, 7). Nothing real: the remote is a bare
// repository on the disk, `gh` is the contractual fake over a JSON file, the agents are the fake CLI
// (scenario delivery-polish: every agent answers a prompt with an `accepted` report of the issue). The test
// commits in the worktrees itself, as the agents would.
//
// RED until the polish passes and the settings dialog exist (T058 to T060). Assumed:
//   - the saved `workspace.delivery` holds `polishPasses` and `polishBrief`; the loop, once PACT’s proof is laid,
//     is `polishing` with `polish: { done: 0, total: N }`;
//   - `polish_pass({ issue, notes })` is a tool of the orchestrator; the instruction reaches the dev in the
//     journal (`exchanges.messages`, kind `instruction`, to the dev) with the brief, the notes and the sentence
//     « Aucune nouvelle fonctionnalité » (R23);
//   - the end of a pass is `send_prompt` to the tester (verdict `accepted`), then the proof of PACT on the end
//     commit: `loops[0].polish.done` + 1, `rounds` gets a round `kind: 'polish'` with that `proof.commit`,
//     `round` stays 1;
//   - the dialog « Réglages de livraison » (ui.md) has « Plafond d’allers-retours », « Passes de peaufinage »,
//     « Consigne de peaufinage » and « Enregistrer »; saved values come back when it is opened again.
// The loop stopping at round 5 and the model escalation at 5 are covered by unit tests (loop-service.test.ts).

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
const BRIEF = 'Renomme les variables à une lettre';
const NOTES = 'Et supprime les commentaires obsolètes';

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us54-', { 'README.md': '# test\n' }));
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
    JSON.stringify({ remote: REMOTE, gitRemote: bare, prs: {}, required: [] }),
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
  FAKE_CLI_SCENARIO: scenarioPath('delivery-polish'),
});

const ghCalls = async (): Promise<string[][]> =>
  (await readFile(ghLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);

const forge = async () =>
  JSON.parse(await readFile(ghState, 'utf8')) as { prs: Record<string, Record<string, unknown>> };

type SavedRound = {
  n: number;
  kind: string;
  proof: { commit: string | null; exitCode: number } | null;
  reports: { role: string; verdict?: { result: string } }[];
};

/** The saved workspace: what a restart would find. */
async function saved(): Promise<{
  loops: {
    state: string;
    round: number;
    rounds: SavedRound[];
    polish: { done: number; total: number } | null;
  }[];
  issues: { id: string; state: string }[];
  delivery: {
    auto: boolean;
    mergeMode: string;
    maxRounds: number;
    polishPasses: number;
    polishBrief: string;
  };
  agents: { id: string; role: string }[];
  exchanges: { messages: { to: string; kind: string; text: string }[] };
}> {
  const dir = join(launched?.userDataDir ?? '', 'workspaces');
  const [file] = await readdir(dir);
  const text = await readFile(join(dir, file ?? ''), 'utf8');
  return (JSON.parse(text) as { data: never }).data;
}

/** Opens the repository, writes a ready issue, the test command and the delivery settings, relaunches. */
async function openWithIssue(delivery: Record<string, unknown> = {}): Promise<Page> {
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
  const content = JSON.parse(await readFile(path, 'utf8')) as {
    data: { delivery?: Record<string, unknown> } & Record<string, unknown>;
  };
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
      data: {
        ...content.data,
        issues: [issue],
        testCommand: 'git --version',
        delivery: { ...content.data.delivery, ...delivery },
      },
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
  await writeFile(join(devTree, 'src', 'connexion.ts'), 'export const c = 1;\n');
  git(devTree, 'add', '-A');
  git(devTree, 'commit', '-m', 'feat: connexion');
}

/** From a launched team to the proof of PACT on the accepted verdict: the loop polishes (or is accepted). */
async function toTheProof(page: Page) {
  const { lead, dev, tester } = await launchTeam(page);
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
  await expect(dev).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  return { lead, dev, tester };
}

test('US5 sc.2: 2 passes set, the verdict accepted: the delivery is refused with « Passe 1 sur 2 à finir. » and no PR is created', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue({ polishPasses: 2, polishBrief: BRIEF });
  const { lead } = await toTheProof(page);
  await expect
    .poll(async () => (await saved()).loops[0]?.state, { timeout: 30_000 })
    .toBe('polishing');
  expect((await saved()).loops[0]?.polish).toMatchObject({ done: 0, total: 2 });

  await call(page, lead, 'request_delivery', {
    issue: ISSUE,
    title: 'Connexion par e-mail',
    message: 'feat: connexion',
  });

  await expect(lead).toContainText('Passe 1 sur 2 à finir.', { timeout: 30_000 });
  expect(Object.keys((await forge()).prs)).toEqual([]);
  expect((await ghCalls()).filter(([a, b]) => a === 'pr' && b === 'create')).toHaveLength(0);
  expect((await saved()).issues[0]?.state).toBe('in-progress');
});

test('US5 sc.3: a pass: the dev gets the brief and the ban on new features, the tester verifies, PACT lays the proof on the end commit, the passes advance and the rounds do not', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue({ polishPasses: 2, polishBrief: BRIEF });
  const { lead, dev, tester } = await toTheProof(page);
  await expect
    .poll(async () => (await saved()).loops[0]?.state, { timeout: 30_000 })
    .toBe('polishing');

  await call(page, lead, 'polish_pass', { issue: ISSUE, notes: NOTES });

  // The instruction is in the journal, to the dev, with the brief, the notes and the ban (sc.4).
  await expect
    .poll(
      async () => {
        const state = await saved();
        const devId = state.agents.find((a) => a.role === 'dev')?.id;
        return state.exchanges.messages.find(
          (m) => m.to === devId && m.kind === 'instruction' && m.text.includes(BRIEF),
        )?.text;
      },
      { timeout: 60_000 },
    )
    .toEqual(
      expect.stringContaining(
        'Aucune nouvelle fonctionnalité : corrige seulement ce qui est demandé',
      ),
    );
  const instruction = (await saved()).exchanges.messages.find((m) => m.text.includes(BRIEF));
  expect(instruction?.text).toContain(NOTES);
  await expect(dev).not.toHaveAttribute('data-state', 'working', { timeout: 30_000 });

  // The dev committed its polish; the tester verifies; PACT runs its tests on that commit.
  const devTree = agentWorktree(repo, 2);
  await writeFile(join(devTree, 'src', 'connexion.ts'), 'export const connexion = 1;\n');
  git(devTree, 'add', '-A');
  git(devTree, 'commit', '-m', 'refactor: noms');
  const end = git(devTree, 'rev-parse', 'HEAD');
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });

  await expect
    .poll(async () => (await saved()).loops[0]?.polish?.done, { timeout: 90_000 })
    .toBe(1);
  const loop = (await saved()).loops[0];
  expect(loop).toMatchObject({ state: 'polishing', round: 1, polish: { done: 1, total: 2 } });
  expect(loop?.rounds.filter((r) => r.kind === 'round')).toHaveLength(1);
  const pass = loop?.rounds.filter((r) => r.kind === 'polish') ?? [];
  expect(pass).toHaveLength(1);
  expect(pass[0]?.proof).toMatchObject({ commit: end, exitCode: 0 });
  expect(pass[0]?.reports.some((r) => r.role === 'test' && r.verdict?.result === 'accepted')).toBe(
    true,
  );
  await expect(tester).not.toHaveAttribute('data-state', 'working');
  // One pass of two is done: the delivery is still refused, with the next pass named.
  await call(page, lead, 'request_delivery', {
    issue: ISSUE,
    title: 'Connexion par e-mail',
    message: 'feat: connexion',
  });
  await expect(lead).toContainText('Passe 2 sur 2 à finir.', { timeout: 30_000 });
});

test('US5 sc.7: the settings of the project (a ceiling of 5, 1 pass) are kept and shown again, and the loop announces the ceiling of 5, not 3', async () => {
  test.setTimeout(300_000);
  const page = await openWithIssue();

  await page.getByRole('button', { name: 'Réglages de livraison' }).click();
  const dialog = page.getByRole('dialog', { name: 'Réglages de livraison' });
  await dialog.getByRole('spinbutton', { name: 'Plafond d’allers-retours' }).fill('5');
  await dialog.getByRole('spinbutton', { name: 'Passes de peaufinage' }).fill('1');
  await dialog.getByRole('textbox', { name: 'Consigne de peaufinage' }).fill(BRIEF);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(async () => (await saved()).delivery, { timeout: 30_000 })
    .toMatchObject({ maxRounds: 5, polishPasses: 1, polishBrief: BRIEF, mergeMode: 'squash' });

  // Out of bounds: refused, nothing saved.
  await page.getByRole('button', { name: 'Réglages de livraison' }).click();
  const again = page.getByRole('dialog', { name: 'Réglages de livraison' });
  await expect(again.getByRole('spinbutton', { name: 'Plafond d’allers-retours' })).toHaveValue(
    '5',
  );
  await expect(again.getByRole('spinbutton', { name: 'Passes de peaufinage' })).toHaveValue('1');
  await again.getByRole('spinbutton', { name: 'Plafond d’allers-retours' }).fill('11');
  await again.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(again.getByRole('alert')).toBeVisible();
  expect((await saved()).delivery.maxRounds).toBe(5);
  await again.getByRole('button', { name: 'Annuler' }).click();

  const { lead } = await launchTeam(page);
  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée : tour 1/5`, { timeout: 30_000 });
  await expect(lead).not.toContainText('3 tours');
});
