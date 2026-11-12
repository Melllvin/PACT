import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeMessage } from '../../../../src/shared/exchanges';
import type { Agent, Workspace } from '../../../../src/shared/model';
import { WakeService } from '../../../../src/main/orchestrator/wake-service';

// 007 T038 — the lane of the full turn waits for a hook when the CLI has one (`midTurnWake`), but a
// hook that never comes must lose nothing: the pointer is typed at the empty prompt, as in phase 3,
// and only once. Fake clock only.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);

let current: Workspace;
let typed: string[];
let wake: WakeService;

const setState = (state: Agent['state']) => {
  current = {
    ...current,
    agents: current.agents.map((a) => (a.id === LEAD ? { ...a, state } : a)),
  };
};

const push = () => {
  const message = {
    id: uuid(1000),
    at: new Date().toISOString(),
    from: DEV,
    to: LEAD,
    type: 'action',
    kind: 'report',
    text: 'texte',
    unreadBy: [LEAD],
  } as ExchangeMessage;
  current = {
    ...current,
    exchanges: { ...current.exchanges, messages: [...current.exchanges.messages, message] },
  };
  wake.notify(current.id, message);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
  current = {
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [
      {
        id: LEAD,
        workspaceId: 'w1',
        position: 1,
        cliId: 'claude-code',
        role: 'orchestrator',
        state: 'working',
      },
      {
        id: DEV,
        workspaceId: 'w1',
        position: 2,
        cliId: 'claude-code',
        role: 'dev',
        state: 'working',
      },
    ],
    exchanges: { messages: [], escalations: [] },
  } as unknown as Workspace;
  typed = [];
  wake = new WakeService({
    workspaces: {
      get: (id) => (id === current.id ? current : undefined),
      list: () => [current],
    },
    type: (_agentId, line) => {
      typed.push(line);
    },
    inputBusy: () => false,
    setNotice: () => undefined,
    usageHeld: () => false,
  });
});

afterEach(() => {
  wake.dispose();
  vi.useRealTimers();
});

describe('a hook that never comes (T038)', () => {
  it('Given an agent in a turn and an action event, When no hook arrives and the turn ends without a usable Stop, Then the pointer is typed once at the empty prompt', async () => {
    push();
    // The window is over and the agent is still at work: nothing is typed.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(typed).toEqual([]);

    setState('awaiting-prompt');
    wake.agentChanged(LEAD);
    expect(typed).toEqual(['1 événement, lis get_events']);

    // Further changes of state announce nothing again.
    setState('done');
    wake.agentChanged(LEAD);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(typed).toHaveLength(1);
  });

  it('Given a hook that answered nothing during the window, When the turn then ends, Then the pointer is still typed once', async () => {
    push();
    expect(wake.takeForHook(LEAD, 'tool')).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    setState('done');
    wake.agentChanged(LEAD);
    expect(typed).toEqual(['1 événement, lis get_events']);
    expect(wake.takeForHook(LEAD, 'stop')).toBeNull();
  });
});
