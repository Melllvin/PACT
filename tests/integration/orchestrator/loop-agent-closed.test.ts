import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, Workspace } from '../../../src/shared/model';
import { createDeliveryHarness, type DeliveryHarness } from '../delivery/delivery-harness';
import { callTool, createHarness, type Harness } from './harness';

// 008 T048 — US6 sc.3, 4, 6; FR-026, SC-006; research R12. A loop whose agent leaves is no longer
// `running`: the orchestrator is woken, the issue is free for `start_loop`; in a delivery, the user
// who closes an agent makes the request fall, the loop `closed`, the PR stays open.
//
// RED until T052: `LoopService.agentClosed` does not exist, a loop stays `running` and its issue
// `in-progress` for ever, `start_loop` refuses it; `DeliveryService` knows no closed agent.
//
// ASSUMED API (R12 names `agentClosed`; the signatures are mine, listed in the report):
//   - `LoopService.agentClosed(agentId): Promise<void>`: for the loops of that agent as dev or as tester
//     in `running`, `polishing` or `accepted`: state `closed`, issue `ready`, ONE notice `loop` to the
//     orchestrator naming the issue. Any other state (`delivering`, `merged`, `escalated`, `closed`) is
//     left as it is. The agent may be GONE from the workspace (a closed tile is forgotten): the loops
//     are found by the id alone;
//   - `DeliveryService.agentClosed(agentId): Promise<void>`: the requests of that agent (dev or tester)
//     that are not final fall (`dropped`, PR kept), the orchestrator hears `dropped`; nothing is closed,
//     no `gh` call touches the PR. The app calls it BEFORE `LoopService.agentClosed` (Q10) on the event
//     `agent:state` `closed`; the loop of a fallen request goes to `closed` (not back to `running` as
//     for a foreign commit);
//   - both are tolerant of a second call (idempotent), so that the order of the two does not matter.
// The wiring on `agent:state` `closed` is src/main/index.ts (T052): not covered here, covered by the
// E2E tests/e2e/us55-restart.spec.ts sc.3. In the first part the harness replays what index.ts does.

const ID = '0012-connexion';
const issue: Issue = {
  id: ID,
  title: 'Connexion',
  path: `.pact/issues/${ID}.md`,
  state: 'ready',
  remote: null,
  trace: { branch: null, agents: [], pr: null },
};

type Closable = { agentClosed?: (agentId: string) => Promise<void> };
/** `agentClosed` as the app calls it; its absence is the failure the tests show. */
async function agentClosed(service: unknown, agentId: string) {
  const loose = service as Closable;
  expect(typeof loose.agentClosed, 'agentClosed() (T052, R12)').toBe('function');
  await (loose.agentClosed as (id: string) => Promise<void>).call(service, agentId);
}

describe('Given a loop and an agent that the user closes (sc.3, 4, SC-006)', () => {
  let h: Harness;
  let token: string;
  let devId: string;
  let testId: string;

  beforeEach(async () => {
    // What index.ts does on `agent:state`: the harness replays it for the closed event.
    h = await createHarness({
      onState: (event: { agentId: string; state: string }) => {
        h.events.push(event as never);
        h.orchestrator.agentState(event as never);
        if (event.state === 'closed') {
          void (h.loops as unknown as Closable).agentClosed?.(event.agentId);
        }
      },
    });
    const register = h.hooks.registerMcp.bind(h.hooks);
    vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
      const issued = register(id, handler);
      token ||= issued;
      return issued;
    });
    token = '';
    await h.launch([h.draft({ orchestrator: true })]);
    const [dev] = await h.launch([h.draft({ role: 'dev' })]);
    const [test] = await h.launch([h.draft({ role: 'test' })]);
    devId = dev?.id ?? '';
    testId = test?.id ?? '';
    await mkdir(join(h.repo, '.pact', 'issues'), { recursive: true });
    await writeFile(join(h.repo, issue.path), `# ${issue.title}\n`);
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      issues: [issue],
      testCommand: 'git --version',
    }));
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.dispose();
  });

  const tool = (name: string, args: Record<string, unknown> = {}) =>
    callTool(h.hooks.mcpUrl(), token, name, args);
  const ws = (): Workspace => h.workspaces.get(h.workspace.id) as Workspace;
  const loop = () => ws().loops.find((l) => l.issueId === ID);
  const issueState = () => ws().issues.find((i) => i.id === ID)?.state;
  const loopNotices = () => h.reports.filter((r) => r.kind === 'loop');
  const startLoop = async () => {
    const started = await tool('start_loop', { issue: ID, dev: devId, test: testId });
    expect(started.isError).toBe(false);
    expect(loop()?.state).toBe('running');
  };
  const close = (id: string) => h.manager.close(id, { removeWorktree: false });
  const setLoopState = (state: string) =>
    h.workspaces.update(h.workspace.id, (w) => ({
      ...w,
      loops: w.loops.map((l) => (l.issueId === ID ? ({ ...l, state } as typeof l) : l)),
    }));

  it.each([
    ['the dev', () => devId],
    ['the tester', () => testId],
  ])(
    'Given a running loop, When the user closes %s, Then the loop is no longer running and the issue is free (sc.3, SC-006)',
    async (_who, which) => {
      await startLoop();
      const before = loopNotices().length;

      await close(which());

      await h.waitFor(() => loop()?.state !== 'running', 'the loop stayed running');
      expect(loop()?.state).toBe('closed');
      expect(issueState()).toBe('ready');
      expect(loopNotices().length).toBe(before + 1);
      expect(loopNotices().at(-1)?.summary).toContain(ID);
    },
    30_000,
  );

  it('Given a loop closed that way, When the orchestrator calls start_loop with another tester, Then it is not refused (sc.4)', async () => {
    await startLoop();
    await close(testId);
    await h.waitFor(() => loop()?.state === 'closed', 'the loop did not close');
    const [again] = await h.launch([h.draft({ role: 'test' })]);

    const restarted = await tool('start_loop', { issue: ID, dev: devId, test: again?.id ?? '' });

    expect(restarted.isError).toBe(false);
    expect(restarted.text).not.toMatch(/pas prête|déjà/);
    expect(loop()?.state).toBe('running');
    expect(loop()?.testAgentId).toBe(again?.id);
    expect(issueState()).toBe('in-progress');
  }, 30_000);

  it.each(['polishing', 'accepted'])(
    'Given a loop %s, When its dev is closed, Then it is closed as well (R12)',
    async (state) => {
      await startLoop();
      await setLoopState(state);

      await close(devId);

      await h.waitFor(() => loop()?.state === 'closed', `the loop stayed ${state}`);
      expect(issueState()).toBe('ready');
    },
    30_000,
  );

  it.each(['merged', 'escalated', 'closed'])(
    'Given a loop %s, When its dev is closed, Then nothing changes and nobody is woken (the closing of the agents at the merge is not a loss)',
    async (state) => {
      await startLoop();
      await setLoopState(state);
      await h.workspaces.update(h.workspace.id, (w) => ({
        ...w,
        issues: w.issues.map((i) => (i.id === ID ? { ...i, state: 'done' } : i)),
      }));
      const before = loopNotices().length;

      await close(devId);
      await new Promise((r) => setTimeout(r, 300));

      expect(loop()?.state).toBe(state);
      expect(issueState()).toBe('done');
      expect(loopNotices().length).toBe(before);
    },
    30_000,
  );

  it('Given a running loop, When an agent that is not in it is closed, Then the loop keeps running', async () => {
    await startLoop();
    const [other] = await h.launch([h.draft({ role: 'dev' })]);

    await close(other?.id ?? '');
    await new Promise((r) => setTimeout(r, 300));

    expect(loop()?.state).toBe('running');
    expect(issueState()).toBe('in-progress');
  }, 30_000);

  it('Given a running loop, When both of its agents are closed one after the other, Then the orchestrator is woken once', async () => {
    await startLoop();
    const before = loopNotices().length;

    await close(devId);
    await h.waitFor(() => loop()?.state === 'closed', 'the loop did not close');
    await close(testId);
    await new Promise((r) => setTimeout(r, 300));

    expect(loopNotices().length).toBe(before + 1);
  }, 30_000);
});

describe('Given a delivery under way and the user who closes an agent (sc.6)', () => {
  let h: DeliveryHarness;

  afterEach(async () => {
    await h.dispose();
  });

  const loopOf = (issueId: string) => h.workspace().loops.find((l) => l.issueId === issueId);
  const issueOf = (issueId: string) => h.workspace().issues.find((i) => i.id === issueId);
  const loopNotices = () =>
    h.notices.filter((n) => (n as { kind?: string }).kind === 'loop') as {
      agentId: string;
      kind: string;
      summary: string;
    }[];
  /** What the app does on `agent:state` `closed`: the delivery first (Q10), then the loop (R12). */
  const userCloses = async (agentId: string) => {
    await agentClosed(h.delivery, agentId);
    await agentClosed(h.loops, agentId);
  };
  const droppedTold = () => h.deliveryMessages().filter((m) => m.delivery?.outcome === 'dropped');

  async function watching(suffix = 'a') {
    const team = await h.team(suffix);
    const request = await h.request(team.dev.id);
    const done = await h.until(request.id, ['watching']);
    return { ...team, request: done };
  }

  it.each(['the dev', 'the tester'] as const)(
    'Given a PR followed, When the user closes %s, Then the request falls, the loop is closed, the issue is free, the PR stays open and the orchestrator is woken',
    async (who) => {
      h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
      const { lead, dev, tester, issue, request } = await watching();
      const closing = who === 'the dev' ? dev : tester;
      const callsBefore = h.ghLog().length;

      await userCloses(closing.id);

      const fallen = h.deliveryOf(request.id);
      expect(fallen.state).toBe('dropped');
      expect(fallen.pr?.number).toBe(1);
      expect(loopOf(issue)?.state).toBe('closed');
      expect(issueOf(issue)?.state).toBe('ready');
      expect(h.prStateOnForge(1)).toBe('OPEN');
      expect(
        h
          .ghLog()
          .slice(callsBefore)
          .some(([a, b]) => a === 'pr' && (b === 'close' || b === 'merge')),
      ).toBe(false);
      expect(h.closed).toEqual([]);
      // The orchestrator hears it: the outcome of the delivery, and the end of the loop.
      expect(droppedTold()).toHaveLength(1);
      expect(droppedTold()[0]).toMatchObject({ to: lead.id });
      expect(loopNotices().filter((n) => n.summary.includes(issue))).toHaveLength(1);
    },
  );

  it('Given a request fallen that way, When the CI turns green with Auto on, Then nothing is merged (the follow stopped)', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await watching();
    await userCloses(dev.id);
    await h.setSettings({ auto: true });

    h.setChecks(h.prHead(1), h.GREEN);
    await new Promise((r) => setTimeout(r, 400));

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
  });

  it('Given a request fallen that way, When the orchestrator starts the loop again with new agents, Then it is not refused', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev, issue } = await watching();
    await userCloses(dev.id);
    const next = await h.addAgent('dev', { branch: 'feat/next' });
    const tester = await h.addAgent('test', { branch: 'test/next' });

    const loop = await h.loops.start(h.workspaceId, { issue, dev: next.id, test: tester.id });

    expect(loop.state).toBe('running');
    expect(issueOf(issue)?.state).toBe('in-progress');
  });

  it('Given two requests, When the user closes the dev of one, Then the other goes on untouched', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const a = await watching('a');
    const b = await watching('b');

    await userCloses(a.dev.id);

    expect(h.deliveryOf(a.request.id).state).toBe('dropped');
    expect(h.deliveryOf(b.request.id).state).toBe('watching');
    expect(loopOf(b.issue)?.state).toBe('delivering');
    expect(droppedTold()).toHaveLength(1);
  });

  it('Given the same closing told twice, When the app repeats it, Then nothing is told twice', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev, issue } = await watching();

    await userCloses(dev.id);
    await userCloses(dev.id);

    expect(droppedTold()).toHaveLength(1);
    expect(loopNotices().filter((n) => n.summary.includes(issue))).toHaveLength(1);
  });

  it('Given a project without remote and a request waiting for « Fusionner », When the user closes the dev, Then it falls and no merge starts', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev, issue } = await h.team('a');
    const request = await h.request(dev.id);
    expect(h.deliveryOf(request.id).state).toBe('reviewing');

    await userCloses(dev.id);

    expect(h.deliveryOf(request.id).state).toBe('dropped');
    expect(loopOf(issue)?.state).toBe('closed');
    expect(h.integrations).toEqual([]);
  });
});
