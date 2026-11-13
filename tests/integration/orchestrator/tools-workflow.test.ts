import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorTools } from '../../../src/main/orchestrator/tools';

// 010 T023 — the tools of the orchestrator around the run of the workflow: `register_issue` says the stage,
// `start_loop` binds the agents and cites the ceiling of the run, `launch_agent({ role: 'spec' })` gets the
// instruction of the spec stage. Without the dependency nothing changes (SC-001).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const TESTER = uuid(3);
const ISSUE = '0012-connexion';

const agent = (id: string, position: number, role: string | null) => ({
  id,
  cliId: 'fake',
  position,
  role,
  state: 'done',
  branch: `agent/${String(position)}`,
});

function make(withWorkflow: boolean) {
  const workspace = {
    id: 'w1',
    status: 'available',
    exchanges: { messages: [], escalations: [] },
    agents: [agent(LEAD, 1, 'orchestrator'), agent(DEV, 2, 'dev'), agent(TESTER, 3, 'test')],
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
    loops: [],
    deliveries: [],
    roleProfiles: {},
    quickLaunchCounters: { freeTerminal: 0 },
  };
  const loop = {
    issueId: ISSUE,
    devAgentId: DEV,
    testAgentId: TESTER,
    round: 1,
    rounds: [],
    state: 'running',
    polish: null,
    escalatedModel: null,
  };
  const workflow = {
    register: vi.fn(() => Promise.resolve({ stage: 'test', status: 'active' })),
    bind: vi.fn(() => Promise.resolve()),
    maxRounds: vi.fn(() => 7),
    specInstruction: vi.fn(() => Promise.resolve('Consigne du workflow : Une issue par fichier.')),
  };
  const tools = createOrchestratorTools(
    {
      workspaces: { list: () => [workspace] },
      cliName: () => 'Faux CLI',
      agents: { close: vi.fn() },
      delivery: { request: vi.fn() },
      loops: {
        start: vi.fn(() => Promise.resolve({ ...loop, sent: [] })),
        next: vi.fn(() => Promise.resolve({ ...loop, round: 4 })),
        get: vi.fn(() => ({ ...loop, round: 2 })),
        polish: vi.fn(),
      },
      issues: {
        register: vi.fn(() =>
          Promise.resolve({
            issue: { id: ISSUE, title: 'Connexion', state: 'ready' },
            missing: [],
          }),
        ),
        list: vi.fn(() => []),
        requestPublish: vi.fn(),
      },
      ...(withWorkflow ? { workflow } : {}),
      log: vi.fn(),
    } as never,
    LEAD,
  );
  const call = (name: string, args: unknown) => tools.find((t) => t.name === name)?.call(args);
  return { call, workflow };
}

const textOf = (result: { content: { text: string }[] } | undefined) =>
  result?.content[0]?.text ?? '';

describe('with a workflow', () => {
  it('Given a ready issue, When register_issue answers, Then it says the stage of the run', async () => {
    const { call, workflow } = make(true);

    const result = await call('register_issue', { path: `${ISSUE}.md` });

    expect(workflow.register).toHaveBeenCalledWith('w1', ISSUE);
    expect(textOf(result)).toBe(`${ISSUE} : ready. Étape test.`);
    expect(JSON.parse(result?.content[1]?.text ?? '{}')).toMatchObject({ stage: 'test' });
  });

  it('Given a loop to start, When start_loop answers, Then the agents are bound and the ceiling is the one of the run', async () => {
    const { call, workflow } = make(true);

    const result = await call('start_loop', { issue: ISSUE, dev: DEV, test: TESTER });

    expect(workflow.bind).toHaveBeenCalledWith('w1', ISSUE, { test: TESTER, dev: DEV });
    expect(textOf(result)).toContain('tour 1/7');
  });

  it('Given the next round, When next_round and get_loop answer, Then they cite the ceiling of the run', async () => {
    const { call } = make(true);

    expect(textOf(await call('next_round', { issue: ISSUE }))).toContain(`${ISSUE} : tour 4/7.`);
    expect(textOf(await call('get_loop', { issue: ISSUE }))).toContain('tour 2/7');
  });
});

describe('without a workflow (SC-001)', () => {
  it('Given no dependency, When register_issue and start_loop answer, Then nothing about stages and the ceiling of the project', async () => {
    const { call } = make(false);

    const registered = await call('register_issue', { path: `${ISSUE}.md` });
    const started = await call('start_loop', { issue: ISSUE, dev: DEV, test: TESTER });

    expect(textOf(registered)).toBe(`${ISSUE} : ready.`);
    expect(JSON.parse(registered?.content[1]?.text ?? '{}')).not.toHaveProperty('stage');
    expect(textOf(started)).toContain('tour 1/3');
  });
});
