import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, outputOf, typeIn } from './helpers/workspace';

// 007 US1 end to end (T022): an orchestrator that is idle is woken by ONE line typed in its prompt
// when an agent reports; PACT types nothing of the agent's text; it never writes over what the user
// typed; the instruction of the orchestrator reaches its agent by the journal; the journal survives a
// restart and the unread events are announced again (US1 sc.1 to 5, 7 and 9, SC-002).
//
// The orchestrator (Faux CLI 1), a dev (Faux CLI 2, role dev) and an agent without role (Faux CLI 3).
// The dev reports as many times as the line it is given has `|`-separated parts: `A` gives one
// report, `A|B|C` three, all in the same turn, hence inside the window of 5 s.
//
// Time: the window is 5 s and PACT's clock is the real one; a wait below only has to be longer than
// what it waits for, so a slow machine can only make a test slower, not wrong.

const env = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-wake'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us30-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const tiles = (page: Page) => ({
  lead: page.getByRole('article', { name: /^Faux CLI 1,/ }),
  dev: page.getByRole('article', { name: /^Faux CLI 2,/ }),
  plain: page.getByRole('article', { name: /^Faux CLI 3,/ }),
});

/** An orchestrator, a dev and an agent without role, from the detailed launcher. */
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
  await detailed.getByRole('button', { name: 'Lancer 3 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const team = tiles(page);
  for (const tile of Object.values(team)) {
    await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  }
  return team;
}

async function openTeam(): Promise<{ page: Page } & ReturnType<typeof tiles>> {
  launched = await launchApp({ env });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  return { page, ...(await launchTeam(page)) };
}

const countOf = async (tile: Locator, text: RegExp) =>
  (((await tile.textContent()) ?? '').match(text) ?? []).length;
const POINTER = /Reçu : \d+ événements?, lis get_events/g;

test('US1 sc.1, SC-002: a report wakes the idle orchestrator with one pointer line, in less than 10 s, and none of its text', async () => {
  test.setTimeout(150_000);
  const { page, lead, dev } = await openTeam();

  await typeIn(page, dev, 'RAPPORT-SECRET-A');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.');
  const reported = Date.now();
  await expect(lead).toContainText('Reçu : 1 événement, lis get_events', { timeout: 10_000 });
  expect(Date.now() - reported).toBeLessThan(10_000);
  // The orchestrator reads it by get_events, with no wait_for_agents.
  await expect(lead).toContainText('MCP get_events :');
  // What PACT typed is the pointer and nothing else: no word of the report in the prompt…
  await expect(lead).not.toContainText('Reçu : RAPPORT-SECRET-A');
  await expect(lead).not.toContainText('wait_for_agents');
  // … and it was typed once, even after the window has long gone.
  await page.waitForTimeout(7_000);
  expect(await countOf(lead, POINTER)).toBe(1);
});

test('US1 sc.2: three action events in the window give one pointer that announces 3', async () => {
  test.setTimeout(150_000);
  const { page, lead, dev } = await openTeam();

  await typeIn(page, dev, 'UN|DEUX|TROIS');
  await expect(lead).toContainText('Reçu : 3 événements, lis get_events', { timeout: 15_000 });
  await page.waitForTimeout(7_000);
  expect(await countOf(lead, POINTER)).toBe(1);
});

test('US1 sc.3, sc.4: an info event types nothing but is read later; what was read is not delivered again', async () => {
  test.setTimeout(150_000);
  const { page, lead, dev, plain } = await openTeam();

  // An agent without role finishes its turn: an `info` event for the orchestrator, no pointer.
  await typeIn(page, plain, 'Travaille');
  await expect(plain).toHaveAttribute('data-state', 'done');
  // The report that follows opens the window: the pointer announces ONE event (the action), and the
  // reading gives the three that are unread: the info of the first agent, the report, the end of
  // the turn of the dev.
  await typeIn(page, dev, 'PREMIER');
  await expect(lead).toContainText('Reçu : 1 événement, lis get_events', { timeout: 15_000 });
  await expect(lead).toContainText('MCP get_events : 3 événement(s).');
  await expect(lead).not.toContainText('Reçu : 2 événements');

  // A second report: the next reading gives the new events only (the report and the end of the turn).
  await expect(lead).toHaveAttribute('data-state', 'done');
  await typeIn(page, dev, 'SECOND');
  await expect(lead).toContainText('MCP get_events : 2 événement(s).', { timeout: 15_000 });
  await expect(lead).not.toContainText(/MCP get_events : [4-9] événement/);
});

test('US1 sc.5: nothing is written over what the user typed; the pointer comes once the prompt is sent', async () => {
  test.setTimeout(150_000);
  const { page, lead, dev } = await openTeam();

  // The user has started a line in the prompt of the orchestrator.
  await lead.locator('.xterm').click();
  await page.keyboard.type('brouillon');
  await expect(lead).toContainText('brouillon');

  await typeIn(page, dev, 'RAPPORT');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.');
  // Well after the window (5 s): still nothing written.
  await page.waitForTimeout(8_000);
  await expect(lead).not.toContainText('Reçu :');
  await expect(lead).not.toContainText('événement, lis get_events');
  await expect(lead).toHaveAttribute('data-state', 'awaiting-prompt');

  // The user sends his line: it is played whole, then the pointer is typed.
  await lead.locator('.xterm').click();
  await page.keyboard.press('Enter');
  await expect(lead).toContainText('Reçu : brouillon', { timeout: 15_000 });
  await expect(lead).toContainText('Reçu : 1 événement, lis get_events', { timeout: 15_000 });
  await expect(lead).not.toContainText('brouillon1 événement');
  await expect(lead).not.toContainText('Reçu : brouillon1');
});

test('US1 sc.7: a multi-line instruction reaches the agent as an instruction read by get_events, in one piece', async () => {
  test.setTimeout(150_000);
  const { page, lead } = await openTeam();

  await typeIn(page, lead, 'Faux CLI 2');
  await expect(lead).toContainText('MCP send_prompt :');
  // The dev was woken by the pointer, read it, and plays the instruction whole. Read in its log, not
  // in its tile: on a small screen the rows of this turn scroll out of view as they are printed.
  const logged = () => outputOf(page, 2);
  await expect.poll(logged, { timeout: 20_000 }).toContain('MCP get_events :');
  await expect.poll(logged, { timeout: 20_000 }).toContain('Reçu : Consigne ligne un');
  expect(await logged()).toContain('Consigne ligne deux');
  expect(await logged()).not.toContain('pasted_content');
});

test('US1 sc.9: the journal survives a restart and the unread events are announced again', async () => {
  test.setTimeout(240_000);
  const { page, lead, dev } = await openTeam();

  // A held pointer: the user has a line in the prompt, the dev reports, nothing is typed.
  await lead.locator('.xterm').click();
  await page.keyboard.type('brouillon');
  await typeIn(page, dev, 'RAPPORT');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.');

  const userDataDir = launched?.userDataDir ?? '';
  const saved = async () => {
    const dir = join(userDataDir, 'workspaces');
    const [file] = await readdir(dir);
    const content = JSON.parse(await readFile(join(dir, file ?? ''), 'utf8')) as {
      data: {
        agents: { id: string; role: string | null }[];
        exchanges?: { messages: { kind: string; to: string; unreadBy: string[] }[] };
      };
    };
    return content.data;
  };
  // The report is in the journal, unread by the orchestrator.
  await expect
    .poll(
      async () => {
        const data = await saved().catch(() => null);
        const orchestrator = data?.agents.find((a) => a.role === 'orchestrator')?.id;
        return data?.exchanges?.messages.some(
          (m) => m.kind === 'report' && m.to === orchestrator && m.unreadBy.includes(orchestrator),
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(lead).not.toContainText('Reçu :');

  await launched?.close({ keepData: true });
  launched = await launchApp({ userDataDir, env });
  const again = await launched.app.firstWindow();
  const team = tiles(again);
  // The journal is still there; the orchestrator, brought back, is told by a pointer.
  await expect(team.lead).toBeVisible({ timeout: 30_000 });
  // Back after the restart, an agent « à reprendre »: resuming it starts the CLI again.
  await expect(team.lead).toHaveAttribute('data-state', 'error');
  await team.lead.getByRole('button', { name: 'Reprendre' }).click();
  await expect(team.lead).toContainText('Reçu : ', { timeout: 30_000 });
  await expect(team.lead).toContainText(/Reçu : \d+ événements?, lis get_events/);
  const data = await saved();
  expect(data.exchanges?.messages.some((m) => m.kind === 'report')).toBe(true);
});
