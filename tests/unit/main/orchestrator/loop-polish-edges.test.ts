import { describe, expect, it, vi } from 'vitest';
import { LoopService } from '../../../../src/main/orchestrator/loop-service';
import { createOrchestratorTools } from '../../../../src/main/orchestrator/tools';

// 008 T058/T059 — edges of `polish_pass` that the acceptance tests leave out: a journal that fails.

const LEAD = '00000000-0000-4000-8000-000000000001';

describe('polish_pass when nobody got the instruction', () => {
  it('Given a pass opened but no instruction sent, When the tool answers, Then it says to send it with send_prompt', async () => {
    const polish = vi.fn(() => Promise.resolve({ pass: 1, total: 2, sent: [] }));
    const tools = createOrchestratorTools(
      {
        workspaces: {
          list: () => [
            {
              id: 'w1',
              status: 'available',
              agents: [{ id: LEAD, cliId: 'fake', position: 1, role: 'orchestrator' }],
              delivery: { maxRounds: 3 },
            },
          ],
        },
        cliName: () => 'Faux CLI',
        loops: { polish },
      } as never,
      LEAD,
    );

    const result = await tools.find((t) => t.name === 'polish_pass')?.call({ issue: '0012' });

    expect(result?.content[0]?.text).toContain('send_prompt');
    expect(result?.isError).toBeUndefined();
  });
});

describe('the loop between passes', () => {
  const DEV = '00000000-0000-4000-8000-000000000002';
  const TREE = 'a'.repeat(40);
  const make = () => {
    type Ws = { loops: Record<string, unknown>[] } & Record<string, unknown>;
    let ws: Ws = {
      id: 'w1',
      agents: [{ id: DEV, role: 'dev', worktreePath: '/w/dev' }],
      delivery: { maxRounds: 3, polishPasses: 2, polishBrief: '' },
      issues: [{ id: '0012', state: 'in-progress' }],
      loops: [
        {
          issueId: '0012',
          devAgentId: DEV,
          testAgentId: '00000000-0000-4000-8000-000000000003',
          round: 1,
          rounds: [{ n: 1, kind: 'round', reports: [], proof: null, testerTouched: [] }],
          state: 'polishing',
          polish: { done: 0, total: 2, restarted: false },
          escalatedModel: null,
        },
      ],
    };
    const notify = vi.fn();
    const service = new LoopService({
      workspaces: {
        get: () => ws as never,
        list: () => [ws as never],
        update: (_id: string, change: (w: never) => unknown) => {
          ws = change(ws as never) as Ws;
          return Promise.resolve(ws as never);
        },
      },
      git: {
        snapshot: vi.fn(() => Promise.resolve({ commit: 'c', tree: TREE })),
        changedFiles: vi.fn(),
        mergeBase: vi.fn(),
        revParse: vi.fn(() => Promise.resolve('c'.repeat(40))),
        treeOf: vi.fn(() => Promise.resolve(TREE)),
      },
      review: { testPlan: vi.fn() },
      tests: { run: vi.fn() },
      agents: { escalate: vi.fn() },
      notify,
    });
    return { service, notify, loop: () => ws.loops[0] as Record<string, unknown> };
  };
  const passed = {
    agentId: DEV,
    command: 'npm test',
    tree: TREE,
    status: 'passed',
    passedCount: null,
    outputTail: '',
  } as const;

  it('Given no pass running, When a run of the tests passes, Then no pass is counted', async () => {
    const { service, loop, notify } = make();

    await service.testRun(passed);

    expect(loop().polish).toEqual({ done: 0, total: 2, restarted: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it('Given no loop for the issue, When polish_pass is called, Then it is refused', async () => {
    const { service } = make();

    await expect(service.polish('w1', 'inconnue')).rejects.toThrow('Aucune boucle');
  });
});

describe('list_agents while a loop polishes', () => {
  it('Given a dev in a polishing loop, When the orchestrator lists the agents, Then the dev shows its loop', async () => {
    const dev = '00000000-0000-4000-8000-000000000002';
    const tools = createOrchestratorTools(
      {
        workspaces: {
          list: () => [
            {
              id: 'w1',
              status: 'available',
              agents: [
                { id: LEAD, cliId: 'fake', position: 1, role: 'orchestrator', state: 'done' },
                { id: dev, cliId: 'fake', position: 2, role: 'dev', state: 'done', branch: 'b' },
              ],
              loops: [
                {
                  issueId: '0012',
                  devAgentId: dev,
                  testAgentId: 'x',
                  round: 2,
                  state: 'polishing',
                },
              ],
            },
          ],
        },
        cliName: () => 'Faux CLI',
        pending: () => Promise.resolve([]),
        agents: { questionOf: () => null, waitingPrompts: () => 0, undeliveredPrompts: () => 0 },
      } as never,
      LEAD,
    );

    const result = await tools.find((t) => t.name === 'list_agents')?.call({});

    const listed = JSON.parse(result?.content[1]?.text ?? '{}') as {
      agents: { loop: unknown }[];
    };
    expect(listed.agents[0]?.loop).toEqual({ issueId: '0012', round: 2 });
  });
});
