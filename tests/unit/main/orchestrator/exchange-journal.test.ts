import { beforeEach, describe, expect, it } from 'vitest';
import { ExchangeService } from '../../../../src/main/orchestrator/exchange-service';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 R3, T045 — what PACT does about a pair of agents is an `action` for the orchestrator:
// `exchange-escalated` when the pair loops, `exchange-decided` when the user decides.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const TEST = uuid(3);

const agent = (n: number, role: Agent['role']): Agent =>
  ({
    id: uuid(n),
    workspaceId: 'w1',
    position: n,
    cliId: 'claude-code',
    role,
    state: 'awaiting-prompt',
  }) as Agent;

let current: Workspace;
let service: ExchangeService;

const create = () =>
  new ExchangeService({
    workspaces: {
      get: (id: string) => (id === current.id ? current : undefined),
      list: () => [current],
      update: (_id: string, change: (ws: Workspace) => Workspace) => {
        current = change(current);
        return Promise.resolve(current);
      },
    },
    onChange: () => undefined,
    name: () => 'Claude Code',
  });

const withAgents = (agents: Agent[]) => {
  current = {
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents,
    exchanges: { messages: [], escalations: [] },
  } as unknown as Workspace;
  service = create();
};

beforeEach(() => {
  withAgents([agent(1, 'orchestrator'), agent(2, 'dev'), agent(3, 'spec')]);
});

const bounce = async (rounds: number) => {
  for (let i = 0; i < rounds; i++) {
    await service.send('w1', {
      from: i % 2 === 0 ? DEV : TEST,
      to: i % 2 === 0 ? TEST : DEV,
      text: `m${String(i)}`,
    });
  }
};

describe('the escalation of a pair', () => {
  it('Given a pair that bounces a message 3 times each way, When the 6th message is sent, Then an exchange-escalated action reaches the orchestrator', async () => {
    await bounce(6);
    expect(current.exchanges.escalations).toHaveLength(1);
    const notice = current.exchanges.messages.find((m) => m.kind === 'exchange-escalated');
    expect(notice).toMatchObject({
      from: 'pact',
      to: LEAD,
      type: 'action',
      unreadBy: [LEAD],
    });
    expect(notice?.text).toContain('Claude Code 2');
    expect(notice?.text).toContain('Claude Code 3');
  });

  it('Given an escalation and no orchestrator any more, When the user decides, Then the decision is taken and nothing is written to the journal', async () => {
    await bounce(6);
    const id = current.exchanges.escalations[0]?.id ?? '';
    current = { ...current, agents: current.agents.filter((a) => a.role !== 'orchestrator') };
    await service.decide('w1', id, 'cut');
    expect(current.exchanges.escalations[0]?.state).toBe('cut');
    expect(current.exchanges.messages.some((m) => m.kind === 'exchange-decided')).toBe(false);
  });
});

describe('the decision of the user', () => {
  it.each([
    ['resume', /reprise/],
    ['cut', /coupé/],
  ] as const)(
    'Given an escalation, When the user chooses « %s », Then an exchange-decided action reaches the orchestrator',
    async (decision, wording) => {
      await bounce(6);
      const id = current.exchanges.escalations[0]?.id ?? '';
      await service.decide('w1', id, decision);
      const notice = current.exchanges.messages.find((m) => m.kind === 'exchange-decided');
      expect(notice).toMatchObject({ from: 'pact', to: LEAD, type: 'action' });
      expect(notice?.text).toMatch(wording);
      expect(notice?.text).toContain('Claude Code 2');
    },
  );

  it('Given an escalation whose agent has left, When the user decides, Then the notice falls back to the id of the agent', async () => {
    await bounce(6);
    const id = current.exchanges.escalations[0]?.id ?? '';
    current = { ...current, agents: current.agents.filter((a) => a.id !== TEST) };
    await service.decide('w1', id, 'cut');
    const notice = current.exchanges.messages.find((m) => m.kind === 'exchange-decided');
    expect(notice?.text).toContain(TEST);
  });
});
