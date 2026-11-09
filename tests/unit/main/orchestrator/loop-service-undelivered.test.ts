import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopService } from '../../../../src/main/orchestrator/loop-service';
import {
  DEFAULT_TEST_PATHS,
  type Agent,
  type Issue,
  type Workspace,
} from '../../../../src/shared/model';
import type { HandoffReport } from '../../../../src/shared/report';

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
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
  ...overrides,
});

// 004 T019 — the dev ↔ test loop: 3 rounds at most, done only on PACT's own run of the tests,
// an independent tester, the escalation of round 3 (FR-007, FR-017 to FR-020, FR-024).

const TREE = 'a'.repeat(40);
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
  delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
  deliveries: [],
  roleProfiles: {},
  issues: [issue()],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  exchanges: { messages: [], escalations: [] },
  lastOpenedAt: '2026-11-03T00:00:00.000Z',
  status: 'available',
});

let current: Workspace;
let touched: string[] = [];
const git = (mergeBase: (cwd: string, a: string, b: string) => Promise<string>) => ({
  snapshot: vi.fn(() => Promise.resolve({ commit: 'c', tree: TREE })),
  changedFiles: vi.fn(() => Promise.resolve(touched.map((path) => ({ path })))),
  mergeBase: vi.fn(mergeBase),
  // 008 R3 — the head of the dev and its tree.
  revParse: vi.fn(() => Promise.resolve('c'.repeat(40))),
  treeOf: vi.fn(() => Promise.resolve(TREE)),
});
const make = (over: Record<string, unknown> = {}, ag: Agent = tester) => {
  current = base();
  current.agents = [lead, dev, ag, plain];
  const deps = {
    workspaces: {
      get: () => current,
      list: () => [current],
      update: (_id: string, change: (ws: Workspace) => Workspace) => {
        current = change(current);
        return Promise.resolve(current);
      },
    },
    git: git((_c, _a, b) => Promise.resolve(`base-${b}`)),
    review: { testPlan: vi.fn() },
    tests: { run: vi.fn() },
    agents: { escalate: vi.fn() },
    notify: vi.fn(),
    message: vi.fn(() => Promise.resolve({})),
    ...over,
  };
  return { deps, loops: new LoopService(deps as never) };
};
const start = (loops: LoopService, tr = tester) =>
  loops.start('w1', { issue: '0012-connexion', dev: dev.id, test: tr.id });
const verdict: HandoffReport = {
  issue: '0012-connexion',
  status: 'defects',
  summary: 'Défauts',
  files: [],
  checks: [{ command: 'npm test', exitCode: 1 }],
  questions: [],
  verdict: { result: 'defects', defects: ['Un défaut'] },
};

describe('a loop whose messages cannot leave (007 R14)', () => {
  beforeEach(() => {
    touched = [];
  });

  it('starts anyway and says nothing was sent when the journal refuses', async () => {
    const { loops } = make({ message: vi.fn(() => Promise.reject(new Error('plein'))) });
    const started = await start(loops);
    expect(started.state).toBe('running');
    expect(started.sent).toEqual([]);
  });

  it('starts anyway and says nothing was sent when there is no journal', async () => {
    const { loops } = make({ message: undefined });
    expect((await start(loops)).sent).toEqual([]);
    await expect(loops.report(tester.id, verdict)).resolves.toBeNull();
  });

  it('keeps the verdict when the journal refuses to carry it to the dev', async () => {
    const { loops } = make({ message: vi.fn(() => Promise.reject(new Error('plein'))) });
    await start(loops);
    await expect(loops.report(tester.id, verdict)).resolves.toBeNull();
    expect(current.loops[0]?.rounds[0]?.reports).toHaveLength(1);
  });
});

describe('the bases of the control of the tester (007 R12)', () => {
  beforeEach(() => {
    touched = [];
  });

  it('skips a base unknown here, such as origin/main without a remote', async () => {
    const { deps, loops } = make({
      git: git((_c, _a, b) =>
        b === 'origin/main' ? Promise.reject(new Error('unknown')) : Promise.resolve(`base-${b}`),
      ),
    });
    await start(loops);
    touched = ['src/a.ts'];
    await expect(loops.report(tester.id, verdict)).resolves.toMatch(/^Verdict rejeté/);
    expect(deps.git.changedFiles).toHaveBeenCalledTimes(1);
  });

  it('keeps only the files outside the tests that every base reports', async () => {
    const { loops } = make({
      git: {
        ...git((_c, _a, b) => Promise.resolve(`base-${b}`)),
        changedFiles: vi.fn((_c: string, from: string) =>
          Promise.resolve(
            (from === 'base-main' ? ['src/a.ts', 'src/b.ts'] : ['src/b.ts']).map((path) => ({
              path,
            })),
          ),
        ),
      },
    });
    await start(loops);
    const rejection = await loops.report(tester.id, verdict);
    expect(rejection).toContain('src/b.ts');
    expect(rejection).not.toContain('src/a.ts');
  });

  it('adds the explicit baseBranch of the tester', async () => {
    const fromFeature = agent(5, { role: 'test', baseBranch: 'feature' });
    const { deps, loops } = make({}, fromFeature);
    await start(loops, fromFeature);
    await loops.report(fromFeature.id, verdict);
    expect(deps.git.mergeBase).toHaveBeenCalledWith(fromFeature.worktreePath, 'HEAD', 'feature');
  });

  it('refuses to guess when no base is known', async () => {
    const { loops } = make({ git: git(() => Promise.reject(new Error('unknown'))) });
    await start(loops);
    await expect(loops.report(tester.id, verdict)).rejects.toThrow(/Aucune base connue/);
  });
});
