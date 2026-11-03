import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '../../../src/shared/model';
import { callTool, createHarness, type Harness } from './harness';

// 004 T020–T021 — submit_report, start_loop, next_round and get_loop with real repositories and
// fake agents: the report reaches the orchestrator, a turn without one is told, and the issue is
// done only once PACT's own run of the tests passes (FR-017 to FR-019).

let h: Harness;
let token: string;
let devId: string;
let testId: string;

const issue = (state: Issue['state']): Issue => ({
  id: '0012-connexion',
  title: 'Connexion',
  path: '.pact/issues/0012-connexion.md',
  state,
  remote: null,
  trace: { branch: null, agents: [], pr: null },
});

const setIssue = (state: Issue['state']) =>
  h.workspaces.update(h.workspace.id, (ws) => ({
    ...ws,
    issues: [issue(state)],
    testCommand: 'git --version',
  }));

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const issued = register(id, handler);
    token ||= issued;
    return issued;
  });
  token = '';
  await h.launch([h.draft({ orchestrator: true })]);
  const [dev] = await h.launch([h.draft({ role: 'dev' })]);
  const [test] = await h.launch([h.draft({ role: 'test' })], 'role-report');
  devId = dev?.id ?? '';
  testId = test?.id ?? '';
  await setIssue('ready');
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const current = () => h.workspaces.get(h.workspace.id);

describe('start_loop', () => {
  it('is refused for an issue not ready, or agents without the dev and test roles', async () => {
    await setIssue('proposed');
    const notReady = await tool('start_loop', {
      issue: '0012-connexion',
      dev: devId,
      test: testId,
    });
    expect(notReady).toMatchObject({ isError: true });
    expect(notReady.text).toBe('L’issue 0012-connexion n’est pas prête (proposed).');

    await setIssue('ready');
    const swapped = await tool('start_loop', { issue: '0012-connexion', dev: testId, test: devId });
    expect(swapped.text).toBe('Il faut un agent dev et un agent test.');
    expect(h.actionsHeard.map((a) => [a.tool, a.outcome])).toEqual([
      ['start_loop', 'refused'],
      ['start_loop', 'refused'],
    ]);
  });
});

describe('a loop', () => {
  it('goes round on defects, then is done once PACT’s run of the tests passes', async () => {
    const started = await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    expect(started).toMatchObject({
      isError: false,
      text: 'Boucle de 0012-connexion démarrée : tour 1/3.',
    });
    expect(current()?.issues[0]).toMatchObject({ state: 'in-progress' });

    // Round 1: the test finds a defect and reports it with submit_report.
    await tool('send_prompt', { agent: testId, text: '0012-connexion' });
    await h.waitFor(() => h.reports.some((r) => r.kind === 'report'), 'no report heard');
    const heard = Date.now();
    const { text, json } = await tool('wait_for_agents', { agents: [testId], timeoutSeconds: 10 });
    expect((json as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('report');
    expect(text).toContain('a rendu son rapport : Le test échoue');
    expect(Date.now() - heard).toBeLessThan(1000);
    expect(current()?.loops[0]?.rounds[0]?.reports[0]).toMatchObject({
      agentId: testId,
      role: 'test',
      verdict: { result: 'defects' },
    });

    const next = await tool('next_round', { issue: '0012-connexion' });
    expect(next.text).toBe('0012-connexion : tour 2/3.');

    // Round 2: accepted; the issue is done only on PACT's own run of the tests.
    await h.waitFor(
      () => ['done', 'awaiting-prompt'].includes(h.current(testId)?.state ?? ''),
      'the test is still working',
      testId,
    );
    await tool('send_prompt', { agent: testId, text: '0012-connexion' });
    await h.waitFor(() => current()?.issues[0]?.state === 'done', 'issue not done', testId);
    const loop = await tool('get_loop', { issue: '0012-connexion' });
    expect(loop.text).toBe('0012-connexion : tour 2/3, passed.');
    expect(current()?.loops[0]?.rounds[1]?.proof).toMatchObject({ exitCode: 0 });
    const { text: proved } = await tool('wait_for_agents', { agents: [devId], timeoutSeconds: 10 });
    expect(proved).toContain('0012-connexion : tests passés par PACT au tour 2.');
  }, 30_000);

  it('escalates the dev to its ceiling, in the same session (FR-007)', async () => {
    await h.manager.escalate(devId, 'fake-large');
    expect(h.current(devId)?.model).toBe('fake-large');
    await h.waitForState(devId, 'awaiting-prompt');
    // Already on it: nothing restarts.
    const events = h.events.length;
    await h.manager.escalate(devId, 'fake-large');
    expect(h.events.length).toBe(events);
  }, 30_000);

  it('tells the orchestrator when an agent ends its turn without a report', async () => {
    await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    await tool('send_prompt', { agent: devId, text: 'Écris la connexion' });
    await h.waitFor(() => h.reports.some((r) => r.kind === 'report-missing'), 'not told', devId);
    const { text } = await tool('wait_for_agents', { agents: [devId], timeoutSeconds: 10 });
    expect(text).toContain('a fini son tour sans rapport.');
    expect(current()?.loops[0]?.round).toBe(1);
  }, 30_000);

  it('refuses next_round before a defects verdict, and get_loop without a loop', async () => {
    expect((await tool('get_loop', { issue: '0012-connexion' })).text).toBe(
      'Aucune boucle pour 0012-connexion.',
    );
    await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    const early = await tool('next_round', { issue: '0012-connexion' });
    expect(early).toMatchObject({ isError: true });
    expect(early.text).toBe('Le tour 1 attend le verdict « defects » du test.');
  });
});
