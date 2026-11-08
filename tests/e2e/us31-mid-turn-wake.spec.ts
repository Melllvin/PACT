import { rm } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { FAKE_CLI, scenarioPath } from '../fixtures/fake-cli/paths';
import { answerFolderPickers, launchApp, type LaunchedApp } from './helpers/launch-app';
import { createRepo, typeIn } from './helpers/workspace';

// 007 US2 end to end (T034): an agent in the middle of its turn receives the pointer by the reply of
// its hook, and PACT writes nothing in its terminal (sc.1); a Stop that finds an event waiting is
// prolonged, and counts for no end of turn (sc.2, FR-018); a CLI without that hook is typed the
// pointer at the end of its turn (sc.3). Sc.4 (a subagent) has no fake CLI to play it: it is the
// contract and integration tests (T031, T033).
//
// The orchestrator (Faux CLI 1) and a dev (Faux CLI 2, role dev). The orchestrator is typed
// `Faux CLI 2|<n>|<ms>`: it sends an instruction to the dev, posts `n` PostToolUse 1.5 s apart,
// then holds its turn open `ms` before its Stop (scenario orchestra-mid-turn). The dev is woken by
// a pointer, reads the instruction and reports: an `action` event for the orchestrator, which is
// then in the middle of its turn.
//
// Time: the window is 5 s and PACT's clock is the real one; a wait below only has to be longer than
// what it waits for, so a slow machine can only make a test slower, not wrong.

const baseEnv = {
  PACT_FAKE_CLI: FAKE_CLI,
  PACT_FAKE_NODE: process.execPath,
  FAKE_CLI_SCENARIO: scenarioPath('orchestra-mid-turn'),
};

let root: string;
let repo: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  ({ root, repo } = await createRepo('pact-us31w-', { 'README.md': '# test\n' }));
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await rm(root, { recursive: true, force: true });
});

const tiles = (page: Page) => ({
  lead: page.getByRole('article', { name: /^Faux CLI 1,/ }),
  dev: page.getByRole('article', { name: /^Faux CLI 2,/ }),
});

/** An orchestrator and a dev, from the detailed launcher. */
async function launchTeam(page: Page) {
  await page.getByRole('button', { name: /Ajouter des agents/ }).click();
  const quick = page.getByRole('dialog', { name: 'Ajouter au workspace' });
  const plus = quick.getByRole('group', { name: 'Faux CLI' }).getByRole('button', { name: '+' });
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
  await detailed.getByRole('button', { name: 'Lancer 2 agents' }).click();
  await page.keyboard.press('Enter'); // 1m: « Toujours autoriser »
  const team = tiles(page);
  for (const tile of Object.values(team)) {
    await expect(tile).toHaveAttribute('data-state', 'awaiting-prompt');
  }
  return team;
}

async function openTeam(env: Record<string, string> = {}) {
  launched = await launchApp({ env: { ...baseEnv, ...env } });
  const page = await launched.app.firstWindow();
  await answerFolderPickers(launched.app, repo);
  await page.getByRole('button', { name: 'Choisir un dépôt Git…' }).click();
  const team = await launchTeam(page);
  // Every state the orchestrator's tile goes through, from now on: the end of a turn that PACT did
  // not count must leave no `done` behind it.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __leadStates: string[] }).__leadStates = seen;
    const lead = () =>
      Array.from(document.querySelectorAll('article')).find((a) =>
        (a.getAttribute('aria-label') ?? '').startsWith('Faux CLI 1,'),
      );
    const note = () => {
      const state = lead()?.getAttribute('data-state');
      if (state && seen.at(-1) !== state) seen.push(state);
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
  });
  return { page, ...team };
}

const leadStates = (page: Page) =>
  page.evaluate(() => (window as unknown as { __leadStates: string[] }).__leadStates);

const countOf = async (tile: Locator, text: RegExp) =>
  (((await tile.textContent()) ?? '').match(text) ?? []).length;
/** What PACT types for a wake is echoed by the fake CLI as `Reçu : <line>`. */
const TYPED_POINTER = /Reçu : \d+ événements?, lis get_events/g;

test('US2 sc.1: an orchestrator in the middle of its turn gets the pointer from the reply of its tool hook, and nothing is written in its terminal', async () => {
  test.setTimeout(180_000);
  const { page, lead, dev } = await openTeam();

  // 24 tools, 1.5 s apart: the turn lasts about 36 s, the dev reports about 7 s into it.
  await typeIn(page, lead, 'Faux CLI 2|24|0');
  await expect(lead).toHaveAttribute('data-state', 'working');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.', { timeout: 40_000 });

  // The pointer arrives with the first tool that ends once the window of 5 s is over…
  await expect(lead).toContainText('Contexte : 1 événement, lis get_events', { timeout: 40_000 });
  // … while the turn goes on, and PACT typed nothing.
  await expect(lead).toHaveAttribute('data-state', 'working');
  expect(await countOf(lead, TYPED_POINTER)).toBe(0);
  expect(await countOf(lead, /Contexte : /g)).toBe(1);

  // The turn ends by itself; the event, announced, is not announced again, nor typed.
  await expect(lead).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await page.waitForTimeout(8_000);
  expect(await countOf(lead, TYPED_POINTER)).toBe(0);
  expect(await countOf(lead, /Contexte : /g)).toBe(1);
  await expect(lead).not.toContainText('Prolongé');
});

test('US2 sc.2, FR-018: a Stop that finds an event waiting is prolonged by the pointer, and counts for no end of turn', async () => {
  test.setTimeout(180_000);
  const { page, lead, dev } = await openTeam();

  // One tool, then the turn stays open 25 s with no hook: the dev reports during it, and the only
  // hook left to carry the pointer is the Stop.
  await typeIn(page, lead, 'Faux CLI 2|1|25000');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.', { timeout: 40_000 });
  await expect(lead).not.toContainText('Contexte : ');

  await expect(lead).toContainText('Prolongé : 1 événement, lis get_events', { timeout: 60_000 });
  // The prolonged turn reads the event itself, then ends: the second Stop finds nothing new.
  await expect(lead).toContainText('MCP get_events :', { timeout: 30_000 });
  await expect(lead).toHaveAttribute('data-state', 'done', { timeout: 60_000 });

  // One end of turn for the whole thing: the Stop that was prolonged did not move the state.
  const states = await leadStates(page);
  expect(states.filter((s) => s === 'done')).toHaveLength(1);
  expect(states.at(-1)).toBe('done');
  expect(states).not.toContain('error');

  // Nothing was typed: the pointer went by the reply of the hook, and is not announced again.
  await page.waitForTimeout(8_000);
  expect(await countOf(lead, TYPED_POINTER)).toBe(0);
  expect(await countOf(lead, /Prolongé : /g)).toBe(1);
});

test('US2 sc.3: a CLI without that hook is typed the pointer at the end of its turn', async () => {
  test.setTimeout(180_000);
  const { page, lead, dev } = await openTeam({ FAKE_CLI_NO_WAKE_HOOK: '1' });

  await typeIn(page, lead, 'Faux CLI 2|24|0');
  await expect(lead).toHaveAttribute('data-state', 'working');
  await expect(dev).toContainText('MCP submit_report : Rapport reçu.', { timeout: 40_000 });

  // Well past the window of 5 s, the tools keep ending: no hook carries anything, nothing is typed.
  await page.waitForTimeout(8_000);
  await expect(lead).toHaveAttribute('data-state', 'working');
  await expect(lead).not.toContainText('Contexte : ');
  expect(await countOf(lead, TYPED_POINTER)).toBe(0);

  // The turn ends; the pointer is typed once, and the agent reads it.
  await expect(lead).toContainText('Reçu : 1 événement, lis get_events', { timeout: 60_000 });
  await expect(lead).toContainText('MCP get_events :', { timeout: 30_000 });
  await expect(lead).not.toContainText('Prolongé');
  await expect(lead).not.toContainText('Contexte : ');
  await page.waitForTimeout(7_000);
  expect(await countOf(lead, TYPED_POINTER)).toBe(1);
});
