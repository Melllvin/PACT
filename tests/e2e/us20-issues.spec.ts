import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, FAKE_GH, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 004 US3 end to end (T030): the orchestrator writes an issue, PACT says it is ready, and nothing
// is published on the remote before the user says « Créer » in À faire (FR-022 to FR-023).

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us20-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const REMOTE = 'https://github.com/pact/e2e';

/** An orchestrator and an agent; `remote`: what the fake gh answers, none for no remote. */
async function openWithLead(remote: string | null): Promise<{ page: Page; lead: Locator }> {
  launched = await launchApp({
    env: {
      PACT_FAKE_CLI: FAKE_CLI,
      PACT_FAKE_NODE: process.execPath,
      PACT_FAKE_GH: FAKE_GH,
      FAKE_CLI_SCENARIO: scenarioPath('issue-writer'),
      FAKE_GH_LOG: join(root, 'gh.log'),
      ...(remote ? { FAKE_GH_REMOTE: remote } : {}),
    },
  });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const launcher = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  await launcher
    .getByRole('group', { name: 'Faux CLI' })
    .getByRole('button', { name: /^Ajouter un / })
    .click();
  await launcher.getByRole('checkbox', { name: /Orchestrateur/ }).click();
  await launcher.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const lead = page.getByRole('article', { name: /^Faux CLI 1,/ });
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');
  return { page, lead };
}

/** The orchestrator calls `tool` with `args`; its turn also writes the issue file. */
const call = (page: Page, lead: Locator, tool: string, args: Record<string, unknown>) =>
  typeIn(page, lead, `${tool}|${JSON.stringify(args)}`);

/** The issue is written in the first turn, then registered in the second. */
async function registerIssue(page: Page, lead: Locator) {
  await call(page, lead, 'list_issues', {});
  await expect(lead).toContainText('MCP list_issues : Aucune issue.');
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  await call(page, lead, 'register_issue', { path: '0012-connexion.md' });
  await expect(lead).toContainText('MCP register_issue : 0012-connexion : ready.');
  await expect(lead).not.toHaveAttribute('data-state', 'working');
}

test('publishes the issue only once the user says « Créer »', async () => {
  test.setTimeout(120_000);
  const { page, lead } = await openWithLead(REMOTE);
  await registerIssue(page, lead);

  // Refused first: nothing leaves the machine, the orchestrator is told.
  await call(page, lead, 'publish_issues', { ids: ['0012-connexion'] });
  const todo = page.getByRole('listitem').filter({ hasText: '◎ Créer 1 issue ?' });
  await expect(todo).toContainText('Connexion par e-mail');
  await todo.getByRole('button', { name: 'Refuser' }).click();
  await expect(todo).toHaveCount(0);
  const reports = lead.getByRole('list', { name: 'Rapports' });
  await expect(reports).toContainText('Publication refusée');
  await expect(readFile(join(root, 'gh.log'), 'utf8')).rejects.toThrow();

  // Asked again, then created.
  await expect(lead).not.toHaveAttribute('data-state', 'working');
  await call(page, lead, 'publish_issues', { ids: ['0012-connexion'] });
  await todo.getByRole('button', { name: '✓ Créer' }).click();
  await expect(todo).toHaveCount(0);
  await expect(reports).toContainText(`Issues publiées : 0012-connexion → ${REMOTE}/issues/1.`);
  const log = await readFile(join(root, 'gh.log'), 'utf8');
  expect(JSON.parse(log)).toEqual([
    'issue',
    'create',
    '--title',
    'Connexion par e-mail',
    '--body-file',
    expect.stringMatching(/[\\/]\.pact[\\/]issues[\\/]0012-connexion\.md$/),
  ]);
});

test('refuses to publish without a remote', async () => {
  test.setTimeout(120_000);
  const { page, lead } = await openWithLead(null);
  await registerIssue(page, lead);
  await call(page, lead, 'publish_issues', { ids: ['0012-connexion'] });
  await expect(lead).toContainText(
    'Publication impossible (dépôt distant ou gh connecté requis) : no git remotes found',
  );
  await expect(page.getByRole('listitem').filter({ hasText: '◎ Créer' })).toHaveCount(0);
});
