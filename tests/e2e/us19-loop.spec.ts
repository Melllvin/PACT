import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 004 US2 end to end (T023): the orchestrator runs the dev ↔ test loop of an issue; PACT counts
// the rounds, stops after the third « defects » for the user to decide, and calls the issue done
// only once its own run of the tests passes (FR-017 to FR-019).

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

/** The orchestrator calls `tool` with `args`, as the fake CLI reads its prompt. */
const call = (page: Page, lead: Locator, tool: string, args: Record<string, unknown>) =>
  typeIn(page, lead, `${tool}|${JSON.stringify(args)}`);

const reportsOf = async (tile: Locator) =>
  ((await tile.textContent()) ?? '').split('MCP submit_report : Rapport reçu.').length - 1;

/** The orchestrator has the test check the issue, and waits for its n-th report. */
async function testRound(page: Page, lead: Locator, tester: Locator, n: number) {
  await call(page, lead, 'send_prompt', { agent: 'Faux CLI 3', text: ISSUE });
  await expect.poll(() => reportsOf(tester), { timeout: 15_000 }).toBe(n);
  await expect(tester).not.toHaveAttribute('data-state', 'working');
}

test('stops the loop after three rounds of defects, and the user decides', async () => {
  test.setTimeout(180_000);
  const page = await openWithIssue('loop-fails');
  const { lead, dev, tester } = await launchTeam(page);

  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await expect(lead).toContainText(`Boucle de ${ISSUE} démarrée : tour 1/3.`);
  await expect(dev.getByLabel('Tour')).toHaveText('tour 1/3');
  await expect(tester.getByLabel('Tour')).toHaveText('tour 1/3');

  for (let round = 1; round <= 3; round++) {
    await testRound(page, lead, tester, round);
    await expect(lead.getByRole('list', { name: 'Rapports' })).toContainText('Le test échoue');
    if (round < 3) {
      await call(page, lead, 'next_round', { issue: ISSUE });
      await expect(dev.getByLabel('Tour')).toHaveText(`tour ${String(round + 1)}/3`);
    }
  }

  // The third « defects »: PACT stops the loop, refuses a fourth round, the user decides.
  const todo = page.getByRole('listitem').filter({ hasText: '✕ Boucle arrêtée' });
  await expect(todo).toContainText(ISSUE);
  await expect(dev.getByLabel('Tour')).toHaveCount(0);
  await call(page, lead, 'next_round', { issue: ISSUE });
  await expect(lead).toContainText('Plafond de 3 tours atteint : l’utilisateur décide');

  await todo.getByRole('button', { name: 'Abandonner' }).click();
  await expect(todo).toHaveCount(0);
});

test('calls the issue done in the second round, once PACT’s own run of the tests passes', async () => {
  test.setTimeout(180_000);
  const page = await openWithIssue('loop-passes');
  const { lead, dev, tester } = await launchTeam(page);

  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await testRound(page, lead, tester, 1);
  await call(page, lead, 'next_round', { issue: ISSUE });
  await expect(dev.getByLabel('Tour')).toHaveText('tour 2/3');
  await testRound(page, lead, tester, 2);

  const band = lead.getByRole('list', { name: 'Rapports' });
  await expect(band).toContainText(`${ISSUE} : tests passés par PACT au tour 2.`);
  await expect(dev.getByLabel('Tour')).toHaveCount(0);
  await call(page, lead, 'get_loop', { issue: ISSUE });
  await expect(lead).toContainText(`${ISSUE} : tour 2/3, passed.`);
});
