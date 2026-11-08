import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { agentWorktree, createRepo, git, reportsStoredFrom, typeIn } from './helpers/workspace';

// 007 US4 end to end (T053): « start_loop » says what left. The tester gets the instruction to write
// the tests, the dev its own at the first report of the tester (and the verdict as an action); the
// reply of the tool says so (US4 sc.1). A tester put back on a main that moved is not blamed for the
// files that came from main: PACT accepts its verdict (US4 sc.2).
//
// Every agent runs the scenario `loop-start`: the orchestrator calls the tool it is typed
// (`tool|{json}`); the tester and the dev each play the instruction they read, hold their turn for 10 s
// (time to move main and put the tester back on it), write a test file and report « defects » with the
// defect DEFAUT-LOOP; the dev, whose wake lists a verdict with that defect, asks the orchestrator
// VERDICT-LU, which shows the verdict reached it.

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us19-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const ISSUE = '0012-connexion';

/** Opens the repository, then writes a ready issue into the saved workspace and relaunches. */
async function openWithIssue(scenario: string): Promise<Page> {
  const env = {
    PACT_FAKE_CLI: FAKE_CLI,
    PACT_FAKE_NODE: process.execPath,
    FAKE_CLI_SCENARIO: scenarioPath(scenario),
  };
  launched = await launchApp({ env });
  let page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await expect(page.getByRole('button', { name: /Ajouter des agents/ })).toBeVisible();
  const userDataDir = launched.userDataDir;
  await launched.close({ keepData: true });

  // The issues come from register_issue (US3); here, one is written ready.
  const dir = join(userDataDir, 'workspaces');
  const [file] = await readdir(dir);
  const path = join(dir, file ?? '');
  // The saved file is an envelope: { schemaVersion, data } (persistence/store.ts).
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

  launched = await launchApp({ userDataDir, env });
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

const START = `start_loop|${JSON.stringify({ issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' })}`;

test('US4 sc.1: start_loop sends the tester its instruction, the dev its own at the first report, and the reply says so', async () => {
  test.setTimeout(150_000);
  const page = await openWithIssue('loop-start');
  const { lead, dev, tester } = await launchTeam(page);

  await typeIn(page, lead, START);
  // The reply of the tool says that an instruction left.
  await expect(lead).toContainText('MCP start_loop :', { timeout: 20_000 });
  await expect(lead).toContainText(/consigne|instruction/i);
  // The tester reads its instruction, which names the issue.
  await expect(tester).toContainText('Reçu :', { timeout: 30_000 });
  await expect(tester).toContainText(ISSUE);
  // At its first report, the dev gets its own, and the verdict as an action.
  await expect(tester).toContainText('MCP submit_report : Rapport reçu.', { timeout: 40_000 });
  await expect(dev).toContainText(ISSUE, { timeout: 60_000 });
  await expect(dev).toContainText('MCP ask_orchestrator :', { timeout: 60_000 });
});

test('US4 sc.2: a tester put back on a main that moved gets its verdict accepted by PACT', async () => {
  test.setTimeout(150_000);
  const page = await openWithIssue('loop-start');
  const { lead, tester } = await launchTeam(page);

  // The loop starts; the orchestrator then has the tester check the issue (this scenario does not
  // depend on the instruction of start_loop, which US4 sc.1 covers).
  await typeIn(page, lead, START);
  await expect(lead).toContainText('MCP start_loop :', { timeout: 20_000 });
  await expect(lead).toHaveAttribute('data-state', /awaiting-prompt|done/, { timeout: 40_000 });
  await typeIn(page, lead, `send_prompt|${JSON.stringify({ agent: 'Faux CLI 3', text: ISSUE })}`);
  await expect(tester).toContainText(ISSUE, { timeout: 30_000 });
  // While the tester holds its turn: main moves, and the tester is put back on it.
  await writeFile(join(repo, 'avance.txt'), 'main avance\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'main avance');
  git(agentWorktree(repo, 3), 'rebase', 'main');

  // It writes its tests and reports: the verdict is accepted, not rejected for the files of main.
  await expect(tester).toContainText('MCP submit_report :', { timeout: 40_000 });
  await expect(tester).toContainText('MCP submit_report : Rapport reçu.');
  await expect(tester).not.toContainText('Verdict rejeté');
});

test('SC-001: a whole dev ↔ test loop runs with no wait_for_agents, the orchestrator is woken instead', async () => {
  test.setTimeout(180_000);
  // Given an orchestrator, a dev and a tester on a ready issue, whose tests fail once, then pass
  const page = await openWithIssue('loop-passes');
  const { lead, dev, tester } = await launchTeam(page);

  // When the orchestrator runs both rounds of the loop, never calling wait_for_agents
  const send = async (n: number) => {
    await typeIn(page, lead, `send_prompt|${JSON.stringify({ agent: 'Faux CLI 3', text: ISSUE })}`);
    await expect.poll(() => reportsStoredFrom(page, 3), { timeout: 30_000 }).toBe(n);
    await expect(tester).not.toHaveAttribute('data-state', 'working');
  };
  await typeIn(page, lead, START);
  await expect(lead).toContainText('MCP start_loop :', { timeout: 20_000 });
  await send(1);
  await typeIn(page, lead, `next_round|${JSON.stringify({ issue: ISSUE })}`);
  await expect(dev.getByLabel('Tour')).toHaveText('tour 2/3', { timeout: 20_000 });
  await send(2);

  // Then PACT calls the issue done by its own run, and no wait was ever called
  await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText(
    `${ISSUE} : tests passés par PACT au tour 2.`,
    { timeout: 30_000 },
  );
  await expect(lead).not.toContainText('wait_for_agents');
});
