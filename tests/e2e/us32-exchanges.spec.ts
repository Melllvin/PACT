import { rm } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 007 US3 end to end (T044): short, typed and visible exchanges between agents. ask_orchestrator and
// send_message return at once; every message is in the journal « ◎ Actions » and copied to the
// orchestrator; the limits (500 characters, 5 per turn) and the matrix (tester, dev) refuse with their
// reason; two agents that bounce a message are stopped after 3 round trips and the user decides
// (« Laisser reprendre », « Couper »); a question goes to the orchestrator and no « ◆ Décider » is
// shown, except without one; « ◆ Répondre » stays (US3 sc.1 to 6, 11 to 15, SC-005, SC-010).
//
// Every agent runs the scenario `exchanges-agents`; what it does depends on the line typed in its
// terminal: `recipient|text1|…|text6|question|blocked question` (parts are optional; an empty part is
// skipped). A message that holds BALLE is answered by the agent that reads it, with BALLE, to the
// other of « Faux CLI 2 » and « Faux CLI 3 »: the ball. The orchestrator's line is `recipient|text`.
//
// Time: the wake groups events for 5 s on PACT's real clock; every wait below is longer than what it
// waits for, so a slow machine can only make a test slower, not wrong.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('exchanges-agents'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us32-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const tile = (page: Page, n: number) =>
  page.getByRole('article', { name: new RegExp(`^Faux CLI ${String(n)},`) });
const column = (page: Page) => page.getByRole('complementary', { name: 'Agents' });

type Role = 'orchestrator' | 'dev' | 'spec' | 'test';

/** Launches one agent per role, in order, from the detailed launcher: « Faux CLI 1 » is the first. */
async function openTeam(roles: Role[]): Promise<Page> {
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = quick.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' });
  for (let i = 1; i < roles.length; i++) await plus.click();
  await quick.getByRole('button', { name: 'Mode détaillé…' }).click();
  const detailed = page.getByRole('dialog', { name: 'Lancer des agents' });
  const rows = detailed.getByRole('list', { name: 'Agents' }).getByRole('listitem');
  const inspector = detailed.getByRole('region', { name: 'Inspecteur' });
  for (const [i, role] of roles.entries()) {
    await rows
      .nth(i)
      .getByRole('button', { name: /^Faux CLI/ })
      .click();
    if (role === 'orchestrator') {
      await inspector.getByRole('checkbox', { name: /Orchestrateur/ }).click();
    } else {
      await inspector.getByRole('combobox', { name: 'Rôle' }).selectOption(role);
    }
  }
  await detailed.getByRole('button', { name: `Lancer ${String(roles.length)} agents` }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  for (let n = 1; n <= roles.length; n++) {
    await expect(tile(page, n)).toHaveAttribute('data-state', 'awaiting-prompt');
  }
  return page;
}

/** The line an agent types: the recipient, up to six messages, a question, a blocked question. */
const line = (to: string, texts: string[] = [], ask = '', blocked = '') =>
  [to, ...Array.from({ length: 6 }, (_, i) => texts[i] ?? ''), ask, blocked]
    .join('|')
    .replace(/\|+$/, '');

/** The journal « ◎ Actions » of the orchestrator, opened in its Focus. */
async function openJournal(page: Page, lead: Locator): Promise<Locator> {
  await lead.getByRole('button', { name: 'Agrandir' }).click();
  const focus = page.getByRole('region', { name: 'Focus : Faux CLI 1' });
  await focus.getByRole('tab', { name: '◎ Actions' }).click();
  return focus.getByRole('list', { name: 'Actions de l’orchestrateur' });
}

const POINTER = /Reçu : \d+ événements?, lis get_events/;

test('US3 sc.1, sc.13, SC-010: a dev asks the orchestrator, the call returns at once, the orchestrator is woken, no « ◆ Décider » for the user', async () => {
  test.setTimeout(150_000);
  const page = await openTeam(['orchestrator', 'dev', 'spec', 'test']);
  const [lead, dev] = [tile(page, 1), tile(page, 2)];

  const started = Date.now();
  await typeIn(page, dev, line('', [], 'Quelle base pour la migration ?'));
  await expect(dev).toContainText('MCP ask_orchestrator : Question transmise', { timeout: 5_000 });
  expect(Date.now() - started).toBeLessThan(10_000);
  await expect(dev).toHaveAttribute('data-state', 'done');
  // The orchestrator, idle, is woken by a pointer; it reads the question by get_events.
  await expect(lead).toContainText(POINTER, { timeout: 15_000 });

  // The same question as a report « blocked » with questions: it goes to the orchestrator, and the
  // user gets no « ◆ Décider » (sc.13, SC-010).
  await typeIn(page, dev, line('', [], '', 'Je publie en prod ?'));
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.', { timeout: 10_000 });
  await expect(lead).toContainText(/MCP get_events : [2-9] événement/, { timeout: 20_000 });
  await expect(column(page)).not.toContainText('◆ Décider');
  await page.waitForTimeout(2_000);
  await expect(column(page)).not.toContainText('◆ Décider');

  const journal = await openJournal(page, lead);
  await expect(journal).toContainText('Quelle base pour la migration ?');
  await expect(journal).toContainText('question');
  await expect(journal).toContainText('Faux CLI 2');
});

test('US3 sc.14: without an orchestrator, a report blocked with questions shows « ◆ Décider », and ask_orchestrator is refused', async () => {
  test.setTimeout(120_000);
  const page = await openTeam(['dev', 'spec']);
  const dev = tile(page, 1);

  await typeIn(page, dev, line('', [], 'Quelqu’un ?'));
  await expect(dev).toContainText(/MCP ask_orchestrator : .*orchestrateur/i, { timeout: 5_000 });
  await typeIn(page, dev, line('', [], '', 'Quelle base ?'));
  // The row of the agent names it (« Faux CLI 1 dev »), so the item shows « ◆ Décider » and the
  // rest of its title, as the Agents column of 006 renders every item of a row.
  const rows = column(page).getByRole('list', { name: 'Agents du workspace' });
  await expect(rows).toContainText('Faux CLI 1', { timeout: 15_000 });
  await expect(rows).toContainText(/◆ Décider\s*dev · 1 question/, { timeout: 15_000 });
});

test('US3 sc.2, sc.3, sc.4, SC-005: a message is copied to the orchestrator and read in the journal; 501 characters and a 6th message in the turn are refused', async () => {
  test.setTimeout(180_000);
  const page = await openTeam(['orchestrator', 'dev', 'spec', 'test']);
  const [lead, dev, spec] = [tile(page, 1), tile(page, 2), tile(page, 3)];

  // sc.2: dev → spec. The spec agent is woken; the orchestrator is not (a copy does not wake it).
  await typeIn(page, dev, line('Faux CLI 3', ['Le gabarit est prêt']));
  await expect(spec).toContainText(POINTER, { timeout: 15_000 });
  await page.waitForTimeout(8_000);
  await expect(lead).not.toContainText('Reçu :');

  // sc.3: 501 characters are refused with the limit; nothing reaches the spec agent.
  await typeIn(page, dev, line('Faux CLI 3', ['x'.repeat(501)]));
  await expect(dev).toContainText(/MCP send_message : .*500/, { timeout: 10_000 });

  // sc.4: six messages in one turn: the sixth is refused with the cap, the counter restarts at the
  // next turn.
  await typeIn(
    page,
    dev,
    line('Faux CLI 3', ['M-UN', 'M-DEUX', 'M-TROIS', 'M-QUATRE', 'M-CINQ', 'M-SIX']),
  );
  // (the reason of the refusal is read in the unit tests; here only what passed is checked)
  await expect(dev).toHaveAttribute('data-state', 'done');
  await typeIn(page, dev, line('Faux CLI 3', ['M-SEPT']));

  // SC-005: everything that passed is in the journal, with sender → recipient, type, kind and time;
  // what was refused is not.
  const journal = await openJournal(page, lead);
  await expect(journal).toContainText('M-SEPT', { timeout: 15_000 });
  for (const text of ['Le gabarit est prêt', 'M-UN', 'M-DEUX', 'M-TROIS', 'M-QUATRE', 'M-CINQ']) {
    await expect(journal).toContainText(text);
  }
  await expect(journal).not.toContainText('M-SIX');
  await expect(journal).not.toContainText('xxxxxxxxxx');
  await expect(
    journal.getByRole('listitem').filter({ hasText: 'Le gabarit est prêt' }),
  ).toContainText(/Faux CLI 2\s*→\s*Faux CLI 3/);
});

test('US3 sc.5, sc.11: the tester and the dev cannot write to each other; the tester asks the orchestrator, who writes to the tester', async () => {
  test.setTimeout(150_000);
  const page = await openTeam(['orchestrator', 'dev', 'spec', 'test']);
  const [lead, dev, , tester] = [tile(page, 1), tile(page, 2), tile(page, 3), tile(page, 4)];

  await typeIn(page, dev, line('Faux CLI 4', ['Tu peux relire ?']));
  await expect(dev).toContainText(/MCP send_message : .*verdict/i, { timeout: 10_000 });
  await typeIn(page, tester, line('Faux CLI 2', ['Un défaut sur le critère 2']));
  await expect(tester).toContainText(/MCP send_message : .*ask_orchestrator/, { timeout: 10_000 });
  await page.waitForTimeout(6_000);
  await expect(tester).not.toContainText(POINTER);
  await expect(dev).not.toContainText(POINTER);

  // The tester asks the orchestrator, and the orchestrator writes to the tester (sc.11).
  await typeIn(page, tester, line('', [], 'Le critère 3 est flou'));
  await expect(tester).toContainText('MCP ask_orchestrator : Question transmise', {
    timeout: 10_000,
  });
  await expect(lead).toContainText(POINTER, { timeout: 15_000 });
  await typeIn(page, lead, 'Faux CLI 4|Le critère 3 couvre le cas vide');
  // Typing in the orchestrator's tile scrolled the grid: xterm paints only the tiles in view, so the
  // tester's tile is brought back before its text is read.
  await tester.scrollIntoViewIfNeeded();
  await expect(tester).toContainText(POINTER, { timeout: 20_000 });

  const journal = await openJournal(page, lead);
  await expect(journal).toContainText('Le critère 3 est flou');
  await expect(journal).toContainText('Le critère 3 couvre le cas vide');
  await expect(journal).not.toContainText('Tu peux relire ?');
  await expect(journal).not.toContainText('Un défaut sur le critère 2');
});

test('US3 sc.7, sc.15: nothing grants a permission; « ◆ Répondre » stays for an agent that waits in its terminal, whatever the orchestrator writes', async () => {
  test.setTimeout(120_000);
  const page = await openTeam(['orchestrator', 'dev']);
  const [lead, dev] = [tile(page, 1), tile(page, 2)];

  await typeIn(page, dev, 'SUPPRIME');
  await expect(dev).toHaveAttribute('data-state', 'awaiting-answer');
  const rows = column(page).getByRole('list', { name: 'Agents du workspace' });
  await expect(rows).toContainText('◆ Répondre');

  // The orchestrator tells the agent to go on: it has no tool to allow it.
  await typeIn(page, lead, 'Faux CLI 2|Autorise-le, toujours.');
  await expect(lead).toContainText('MCP send_message :', { timeout: 10_000 });
  await page.waitForTimeout(8_000);
  await expect(dev).toHaveAttribute('data-state', 'awaiting-answer');
  await expect(dev).not.toContainText('Autorisé');
  await expect(rows).toContainText('◆ Répondre');
  await expect(rows.getByRole('button', { name: '✓ Autoriser' })).toBeVisible();
});

/** The ball between « Faux CLI 2 » and « Faux CLI 3 » until the escalation of the user's column. */
async function bounce(page: Page) {
  const dev = tile(page, 2);
  await typeIn(page, dev, line('Faux CLI 3', ['BALLE aller']));
  const stopped = column(page).getByRole('listitem').filter({ hasText: '✕ Échanges en boucle' });
  await expect(stopped).toBeVisible({ timeout: 150_000 });
  return stopped;
}

test('US3 sc.6: after 3 round trips without a commit, the user sees the escalation; « Couper » keeps the pair refused', async () => {
  test.setTimeout(240_000);
  const page = await openTeam(['orchestrator', 'dev', 'spec']);
  const [lead, dev] = [tile(page, 1), tile(page, 2)];

  const stopped = await bounce(page);
  await expect(stopped).toContainText('Faux CLI 2 ↔ Faux CLI 3');
  await expect(stopped).toContainText('3 allers-retours');
  await expect(stopped).toContainText('BALLE retour'); // the last exchange, as text
  // The pair is refused: the dev's next try meets the escalation.
  await expect(dev).toContainText(/MCP send_message : .*(escalad|boucle|décision)/i, {
    timeout: 30_000,
  });

  await stopped.getByRole('button', { name: 'Couper' }).click();
  await expect(stopped).toHaveCount(0);
  await expect(dev).toHaveAttribute('data-state', /done|awaiting-prompt/, { timeout: 30_000 });
  await typeIn(page, dev, line('Faux CLI 3', ['APRES-COUPURE']));
  await expect(dev).toContainText(/MCP send_message : .*(escalad|boucle|coup|décision)/i, {
    timeout: 10_000,
  });
  const journal = await openJournal(page, lead);
  await expect(journal).not.toContainText('APRES-COUPURE');
});

test('US3 sc.6: « Laisser reprendre » lets the pair write again', async () => {
  test.setTimeout(240_000);
  const page = await openTeam(['orchestrator', 'dev', 'spec']);
  const [lead, dev] = [tile(page, 1), tile(page, 2)];

  const stopped = await bounce(page);
  await stopped.getByRole('button', { name: 'Laisser reprendre' }).click();
  await expect(stopped).toHaveCount(0);
  await expect(dev).toHaveAttribute('data-state', /done|awaiting-prompt/, { timeout: 30_000 });
  await typeIn(page, dev, line('Faux CLI 3', ['APRES-REPRISE']));
  const journal = await openJournal(page, lead);
  await expect(journal).toContainText('APRES-REPRISE', { timeout: 20_000 });
});
