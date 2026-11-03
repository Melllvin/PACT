import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopService } from '../../../../src/main/orchestrator/loop-service';
import {
  DEFAULT_TEST_PATHS,
  type Agent,
  type Issue,
  type Workspace,
} from '../../../../src/shared/model';
import type { HandoffReport } from '../../../../src/shared/report';
import type { TestRun } from '../../../../src/shared/review';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(n)}`,
  worktreePath: `/w/.worktrees/claude-code-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'awaiting-prompt',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  effort: null,
  ...overrides,
});

// 004 T019 — the dev ↔ test loop: 3 rounds at most, done only on PACT's own run of the tests,
// an independent tester, the escalation of round 3 (FR-007, FR-017 to FR-020, FR-024).

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const lead = agent(1, { role: 'orchestrator' });
const dev = agent(2, { role: 'dev', model: 'sonnet', branch: 'feat/connexion' });
const tester = agent(3, { role: 'test' });
const plain = agent(4);

const issue = (state: Issue['state'] = 'ready'): Issue => ({
  id: '0012-connexion',
  title: 'Connexion',
  path: '.pact/issues/0012-connexion.md',
  state,
  remote: null,
  trace: { branch: null, agents: [], pr: null },
});

const base = (): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [lead, dev, tester, plain],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: 'npm test',
  integrationRequests: [],
  roleProfiles: {},
  issues: [issue()],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  lastOpenedAt: '2026-11-03T00:00:00.000Z',
  status: 'available',
});

let current: Workspace;
let touched: string[];
let devTree: string;
const notify = vi.fn();
const deps = () => ({
  workspaces: {
    get: (id: string) => (id === current.id ? current : undefined),
    list: () => [current],
    update: (_id: string, change: (ws: Workspace) => Workspace) => {
      current = change(current);
      return Promise.resolve(current);
    },
  },
  git: {
    snapshot: vi.fn((cwd: string) =>
      Promise.resolve({ commit: 'c', tree: cwd === dev.worktreePath ? devTree : TREE }),
    ),
    changedFiles: vi.fn(() => Promise.resolve(touched.map((path) => ({ path })))),
  },
  review: {
    testPlan: vi.fn((agentId: string) =>
      Promise.resolve({
        target: { agentId, cwd: dev.worktreePath, port: dev.port },
        command: 'npm test',
        tree: devTree,
      }),
    ),
  },
  tests: {
    run: vi.fn((target: { agentId: string }, command: string, tree: string) =>
      Promise.resolve<TestRun>({
        agentId: target.agentId,
        command,
        tree,
        status: 'running',
        passedCount: null,
        outputTail: '',
      }),
    ),
  },
  agents: { escalate: vi.fn(() => Promise.resolve()) },
  notify,
});

let d: ReturnType<typeof deps>;
let loops: LoopService;

beforeEach(() => {
  current = base();
  touched = [];
  devTree = TREE;
  notify.mockClear();
  d = deps();
  loops = new LoopService(d as never);
});

const report = (over: Partial<HandoffReport> = {}): HandoffReport => ({
  issue: '0012-connexion',
  status: 'done',
  summary: 'Fait',
  files: ['src/connexion.ts'],
  checks: [{ command: 'npm test', exitCode: 0 }],
  questions: [],
  ...over,
});
const defects = report({
  status: 'defects',
  verdict: { result: 'defects', defects: ['La connexion vide passe'] },
});
const accepted = report({ verdict: { result: 'accepted', defects: [] } });

const start = () => loops.start('w1', { issue: '0012-connexion', dev: dev.id, test: tester.id });
const loop = () => current.loops[0];
const state = () => current.issues[0]?.state;
const kinds = () => notify.mock.calls.map(([, event]) => (event as { kind: string }).kind);
const finished = (status: TestRun['status'], tree = TREE): TestRun => ({
  agentId: dev.id,
  command: 'npm test',
  tree,
  status,
  passedCount: null,
  outputTail: 'FAIL connexion.test.ts',
});

describe('start_loop', () => {
  it('starts round 1 and traces the issue: in progress, its branch and agents (FR-024)', async () => {
    const started = await start();
    expect(started).toMatchObject({ issueId: '0012-connexion', round: 1, state: 'running' });
    expect(state()).toBe('in-progress');
    expect(current.issues[0]?.trace).toEqual({
      branch: 'feat/connexion',
      agents: [dev.id, tester.id],
      pr: null,
    });
    expect(loop()?.rounds).toHaveLength(1);
  });

  it('refuses an issue that is not ready, wrong roles and a second loop', async () => {
    current = { ...current, issues: [issue('proposed')] };
    await expect(start()).rejects.toThrow('L’issue 0012-connexion n’est pas prête (proposed).');
    current = base();
    await expect(
      loops.start('w1', { issue: '0012-connexion', dev: plain.id, test: tester.id }),
    ).rejects.toThrow('Il faut un agent dev et un agent test.');
    await start();
    current = { ...current, issues: [{ ...issue(), state: 'ready' }] };
    await expect(start()).rejects.toThrow('Une boucle tourne déjà pour 0012-connexion.');
  });
});

describe('rounds', () => {
  it('goes to the next round on a defects verdict only', async () => {
    await start();
    await expect(loops.next('w1', '0012-connexion')).rejects.toThrow(
      'Le tour 1 attend le verdict « defects » du test.',
    );
    await loops.report(tester.id, defects);
    await expect(loops.next('w1', '0012-connexion')).resolves.toMatchObject({ round: 2 });
  });

  it('stops after the third defects verdict: escalated, the user decides (FR-018)', async () => {
    await start();
    for (let round = 1; round <= 3; round++) {
      await loops.report(tester.id, defects);
      if (round < 3) await loops.next('w1', '0012-connexion');
    }
    expect(loop()?.state).toBe('escalated');
    expect(state()).toBe('escalated');
    expect(kinds()).toContain('loop');
    await expect(loops.next('w1', '0012-connexion')).rejects.toThrow(
      'Plafond de 3 tours atteint : l’utilisateur décide',
    );
  });

  it('escalates the dev to the ceiling for round 3 when the profile says so (FR-007)', async () => {
    current = {
      ...current,
      roleProfiles: {
        dev: {
          cliId: 'claude-code',
          model: 'sonnet',
          effort: null,
          maxModel: 'opus',
          escalate: true,
        },
      },
    };
    await start();
    await loops.report(tester.id, defects);
    await loops.next('w1', '0012-connexion');
    expect(d.agents.escalate).not.toHaveBeenCalled();
    await loops.report(tester.id, defects);
    await loops.next('w1', '0012-connexion');
    expect(d.agents.escalate).toHaveBeenCalledWith(dev.id, 'opus');
    expect(loop()?.escalatedModel).toBe('opus');
  });

  it('keeps the round when an agent asks the user something or ends a turn', async () => {
    await start();
    loops.turnFinished(dev.id);
    expect(loop()?.round).toBe(1);
  });
});

describe('reports', () => {
  it('keeps each report in its round and tells the orchestrator', async () => {
    await start();
    await expect(loops.report(dev.id, report())).resolves.toBeNull();
    expect(loop()?.rounds[0]?.reports[0]).toMatchObject({ agentId: dev.id, role: 'dev', round: 1 });
    expect(kinds()).toEqual(['report']);
  });

  it('tells the orchestrator when a turn ends without a report (R5)', async () => {
    await start();
    loops.turnFinished(dev.id);
    expect(kinds()).toEqual(['report-missing']);
    notify.mockClear();
    await loops.report(tester.id, defects);
    loops.turnFinished(tester.id);
    expect(kinds()).toEqual(['report']);
  });

  it('rejects the verdict of a test that changed files outside the tests (FR-020)', async () => {
    await start();
    touched = ['src/connexion.ts', 'tests/connexion.test.ts'];
    await expect(loops.report(tester.id, accepted)).resolves.toBe(
      'Verdict rejeté : le test a modifié des fichiers hors tests (src/connexion.ts).',
    );
    expect(loop()?.rounds[0]?.testerTouched).toEqual(['src/connexion.ts']);
    expect(d.tests.run).not.toHaveBeenCalled();
  });
});

describe('the proof (FR-019)', () => {
  it('runs the tests on the dev’s tree, and the issue is done only once they pass there', async () => {
    await start();
    await loops.report(tester.id, accepted);
    expect(d.tests.run).toHaveBeenCalledWith(
      { agentId: dev.id, cwd: dev.worktreePath, port: dev.port },
      'npm test',
      TREE,
    );
    expect(state()).toBe('in-progress');
    await loops.testRun(finished('passed'));
    expect(state()).toBe('done');
    expect(loop()?.state).toBe('passed');
    expect(loop()?.rounds[0]?.proof).toMatchObject({ tree: TREE, exitCode: 0 });
  });

  it('does not count a run that failed, nor one on an older tree', async () => {
    await start();
    await loops.report(tester.id, accepted);
    await loops.testRun(finished('failed'));
    expect(state()).toBe('in-progress');
    expect(notify.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'loop' });
    expect((notify.mock.calls.at(-1)?.[1] as { summary: string }).summary).toContain(
      'FAIL connexion.test.ts',
    );
    devTree = OTHER_TREE;
    await loops.testRun(finished('passed'));
    expect(state()).toBe('in-progress');
  });

  it('ignores the runs of agents outside a loop', async () => {
    await loops.testRun({ ...finished('passed'), agentId: uuid(9) });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('the user’s decision (loop:decide)', () => {
  const escalate = async () => {
    await start();
    for (let round = 1; round <= 3; round++) {
      await loops.report(tester.id, defects);
      if (round < 3) await loops.next('w1', '0012-connexion');
    }
  };

  it('restarts 3 rounds', async () => {
    await escalate();
    await loops.decide('w1', '0012-connexion', 'restart');
    expect(state()).toBe('in-progress');
    expect(loop()).toMatchObject({ state: 'running', round: 1 });
    expect(loop()?.rounds).toHaveLength(1);
  });

  it('takes over: the loop closes, the issue stays escalated', async () => {
    await escalate();
    await loops.decide('w1', '0012-connexion', 'take-over');
    expect(loop()?.state).toBe('closed');
    expect(state()).toBe('escalated');
  });

  it('abandons the issue', async () => {
    await escalate();
    await loops.decide('w1', '0012-connexion', 'abandon');
    expect(loop()?.state).toBe('closed');
    expect(state()).toBe('abandoned');
  });

  it('refuses a decision on a loop still running', async () => {
    await start();
    await expect(loops.decide('w1', '0012-connexion', 'abandon')).rejects.toThrow(
      'La boucle de 0012-connexion n’attend pas de décision.',
    );
  });
});

describe('the orchestrator’s role withdrawn', () => {
  it('closes the running loops and leaves the agents open', async () => {
    await start();
    await loops.closeAll('w1');
    expect(loop()?.state).toBe('closed');
    expect(current.agents).toHaveLength(4);
  });
});
