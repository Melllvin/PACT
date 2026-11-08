import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 006 US3 end to end (T026): an orchestrator, a dev and a test in a dev ↔ test loop (the fake CLI
// scenario of us19-loop) → the « Graphe » view links the orchestrator to its agents and groups the
// loop at round 2; a change of state moves the node in less than a second; a click opens the Focus.
// (tasks.md names this file us30-graph.spec.ts: us30 is taken by the wake spec of 007.)

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us34-', { 'README.md': '# test\n' }));
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

test('links the orchestrator to its agents, groups the loop at round 2, follows the state, opens the Focus', async () => {
  test.setTimeout(180_000);
  const page = await openWithIssue('loop-passes');
  const { lead, dev, tester } = await launchTeam(page);

  // Round 1 is over (defects), round 2 starts: the loop is at « tour 2/3 ».
  await call(page, lead, 'start_loop', { issue: ISSUE, dev: 'Faux CLI 2', test: 'Faux CLI 3' });
  await testRound(page, lead, tester, 1);
  await call(page, lead, 'next_round', { issue: ISSUE });
  await expect(dev.getByLabel('Tour')).toHaveText('tour 2/3');

  // Scenario 1 and 2: the Graphe view links the orchestrator to its agents and groups the loop.
  await page.getByRole('radio', { name: 'Graphe' }).click();
  const graph = page.getByRole('region', { name: 'Graphe des agents' });
  await expect(graph).toBeVisible();
  const nodes = graph.getByRole('list', { name: 'Agents' }).getByRole('button');
  await expect(nodes).toHaveCount(3);
  await expect(
    graph.getByRole('button', { name: /^Faux CLI 1, orchestrateur, .*lancé par vous$/ }),
  ).toBeVisible();
  const devNode = graph.getByRole('button', { name: /^Faux CLI 2, dev, / });
  const testNode = graph.getByRole('button', { name: /^Faux CLI 3, test, / });
  for (const node of [devNode, testNode]) {
    await expect(node).toHaveAccessibleName(/dev ↔ test 2\/3, issue 0012-connexion/);
    await expect(node).toHaveAccessibleName(/lancé par Faux CLI 1$/);
  }
  const group = graph.getByRole('group', { name: `Issue ${ISSUE} · dev ↔ test 2/3` });
  await expect(group.getByRole('button')).toHaveCount(2);
  await expect(graph.locator('svg[aria-hidden="true"]').first()).toBeAttached();
  await expect(graph.locator('svg:not([aria-hidden="true"])')).toHaveCount(0);

  // The audit: no serious accessibility violation (SC-006).
  await expectNoSeriousA11yViolations(page);

  // Scenario 3: the test agent’s second report passes the loop; its node changes in under a second.
  await page.getByRole('radio', { name: 'Tuiles' }).click();
  await testRound(page, lead, tester, 2);
  await expect(
    lead
      .getByRole('list', { name: 'Rapports' })
      .getByText(`${ISSUE} : tests passés par PACT au tour 2.`),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Graphe' }).click();
  await expect(testNode).toHaveAccessibleName(/boucle terminée/, { timeout: 1_000 });

  // Scenario 4: a click on a node opens the Focus of the agent.
  await testNode.click();
  await expect(page.getByRole('region', { name: /^Focus : Faux CLI 3/ })).toBeVisible();
});

test('opens the Focus from the keyboard', async () => {
  test.setTimeout(120_000);
  const page = await openWithIssue('loop-passes');
  await launchTeam(page);
  await page.getByRole('radio', { name: 'Graphe' }).click();
  const node = page
    .getByRole('region', { name: 'Graphe des agents' })
    .getByRole('button', { name: /^Faux CLI 2, / });
  await node.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: /^Focus : Faux CLI 2/ })).toBeVisible();
});
