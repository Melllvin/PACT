import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeKind, ExchangeMessage } from '../../../../src/shared/exchanges';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 T018 — the wake of an agent (research R4, R7, data-model « WakeService »): group the events
// for 5 s, then type ONE pointer, unless the agent cannot take it. Fake clock only: no real wait.
//
// API fixed here for the dev (see the report, « API fixées »):
//   new WakeService({ workspaces: { get, list }, type, inputBusy, setNotice, usageCritical })
//     type(agentId, line)        types the one-line pointer (AgentManager.sendPrompt, origin 'wake')
//     inputBusy(agentId)         the prompt of the agent holds something (draft not empty)
//     setNotice(agentId, notice) Agent.wakeNotice: 'input' | 'cap' | null, saved and announced
//     usageCritical(cliId)       usageAlert(...).level === 'critical' for an account of this CLI
//   notify(workspaceId, message)   a message was recorded (ExchangeService.onRecorded)
//   agentChanged(agentId)          the state or the prompt of the agent changed: try again
//   restore()                      after a restart: announce what is still unread
//   deliver(agentId, { urgent? })  wake now; `urgent` ignores the cap and the usage cut (FR-017)
//   dispose()                      clears every timer
// The module is loaded in `beforeEach`, so that each test fails on its own while it is absent.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);

type Notice = 'input' | 'cap' | null;
type WakeLike = {
  notify(workspaceId: string, message: ExchangeMessage): void;
  agentChanged(agentId: string): void;
  restore(): void;
  deliver(agentId: string, options?: { urgent?: boolean }): void;
  dispose(): void;
};
type WakeOptions = {
  workspaces: { get(id: string): Workspace | undefined; list(): Workspace[] };
  type(agentId: string, line: string): unknown;
  inputBusy(agentId: string): boolean;
  setNotice(agentId: string, notice: Notice): void;
  usageCritical(cliId: string): boolean;
};
type WakeModule = { WakeService: new (options: WakeOptions) => WakeLike };

const modulePath = '../../../../src/main/orchestrator/wake-service';
const load = () => import(/* @vite-ignore */ modulePath) as Promise<WakeModule>;

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
let typed: { agentId: string; line: string }[];
let notices: { agentId: string; notice: Notice }[];
let busy: boolean;
let critical: boolean;
let wake: WakeLike;
let counter: number;

const create = async () => {
  const { WakeService } = await load();
  return new WakeService({
    workspaces: {
      get: (id) => (id === current.id ? current : undefined),
      list: () => [current],
    },
    type: (agentId, line) => {
      typed.push({ agentId, line });
    },
    inputBusy: () => busy,
    setNotice: (agentId, notice) => {
      notices.push({ agentId, notice });
    },
    usageCritical: () => critical,
  });
};

const setState = (id: string, state: Agent['state']) => {
  current = {
    ...current,
    agents: current.agents.map((a) => (a.id === id ? { ...a, state } : a)),
  };
};

/** Writes a message to the journal as ExchangeService would, then tells the service. */
const push = (kind: ExchangeKind = 'report', type: 'action' | 'info' = 'action', to = LEAD) => {
  counter += 1;
  const message = {
    id: uuid(1000 + counter),
    at: new Date().toISOString(),
    from: DEV,
    to,
    type,
    kind,
    text: `texte ${String(counter)}`,
    unreadBy: [to],
  } as ExchangeMessage;
  current = {
    ...current,
    exchanges: { ...current.exchanges, messages: [...current.exchanges.messages, message] },
  };
  wake.notify(current.id, message);
  return message;
};

const markAllRead = () => {
  current = {
    ...current,
    exchanges: {
      ...current.exchanges,
      messages: current.exchanges.messages.map((m) => ({ ...m, unreadBy: [] })),
    },
  };
};

const lines = () => typed.map((t) => t.line);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
  current = {
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [agent(1, 'orchestrator'), agent(2, 'dev')],
    exchanges: { messages: [], escalations: [] },
  } as unknown as Workspace;
  typed = [];
  notices = [];
  busy = false;
  critical = false;
  counter = 0;
  wake = await create();
});

afterEach(() => {
  wake.dispose();
  vi.useRealTimers();
});

describe('the window of 5 s (FR-011, SC-002)', () => {
  it('Given three action events in 5 s, When the window ends, Then one pointer announces 3 events', async () => {
    push();
    await advance(2000);
    push();
    await advance(2000);
    push();
    await advance(999);
    expect(typed).toEqual([]);
    await advance(1);
    expect(typed).toEqual([{ agentId: LEAD, line: '3 événements, lis get_events' }]);
    await advance(60_000);
    expect(typed).toHaveLength(1);
  });

  it('Given a window open, When a later event arrives, Then the window is not extended and the next event opens its own', async () => {
    push();
    await advance(4000);
    push();
    await advance(1000);
    expect(lines()).toEqual(['2 événements, lis get_events']);
    await advance(1000);
    push();
    await advance(4999);
    expect(lines()).toHaveLength(1);
    await advance(1);
    expect(lines()).toEqual(['2 événements, lis get_events', '1 événement, lis get_events']);
  });

  it('Given an idle agent, When one action event arrives, Then the pointer is typed once the 5 s are over and leaves no timer behind', async () => {
    push();
    await advance(5000);
    expect(lines()).toEqual(['1 événement, lis get_events']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given the agent is a done one, When an action event arrives, Then the pointer is typed too', async () => {
    setState(LEAD, 'done');
    push();
    await advance(5000);
    expect(lines()).toEqual(['1 événement, lis get_events']);
  });
});

describe('what wakes and what does not (R3, R4)', () => {
  it('Given an info event, When 60 s pass, Then nothing is typed and it stays unread', async () => {
    const message = push('turn-finished', 'info');
    await advance(60_000);
    expect(typed).toEqual([]);
    expect(
      current.exchanges.messages.find((m) => m.id === message.id)?.unreadBy,
      'the service does not read for the agent',
    ).toEqual([LEAD]);
  });

  it('Given an info and an action event in the window, When it ends, Then the pointer counts the action one only', async () => {
    push('turn-finished', 'info');
    push('report');
    await advance(5000);
    expect(lines()).toEqual(['1 événement, lis get_events']);
  });

  it.each(['awaiting-answer', 'error', 'closed'] as const)(
    'Given an agent in « %s », When an action event arrives, Then nothing is typed, and the pointer comes at the next change of state',
    async (state) => {
      setState(LEAD, state);
      push();
      await advance(20_000);
      expect(typed).toEqual([]);
      setState(LEAD, 'awaiting-prompt');
      wake.agentChanged(LEAD);
      await advance(1);
      expect(lines()).toEqual(['1 événement, lis get_events']);
    },
  );

  it('Given an agent that goes from awaiting-prompt to working during the window, When it ends, Then nothing is typed', async () => {
    push();
    await advance(2000);
    setState(LEAD, 'working');
    await advance(3000);
    expect(typed).toEqual([]);
    await advance(30_000);
    expect(typed).toEqual([]);
  });

  it('Given that held pointer, When the agent ends its turn, Then it is typed once', async () => {
    push();
    await advance(2000);
    setState(LEAD, 'working');
    await advance(3000);
    setState(LEAD, 'done');
    wake.agentChanged(LEAD);
    await advance(1);
    expect(lines()).toEqual(['1 événement, lis get_events']);
    wake.agentChanged(LEAD);
    await advance(10_000);
    expect(lines()).toHaveLength(1);
  });

  it('Given events read by get_events before the window ends, When it ends, Then no pointer is typed', async () => {
    push();
    push();
    await advance(2000);
    markAllRead();
    await advance(3000);
    expect(typed).toEqual([]);
  });

  it('Given only some events read, When the window ends, Then the pointer announces the ones still unread', async () => {
    const first = push();
    push();
    await advance(2000);
    current = {
      ...current,
      exchanges: {
        ...current.exchanges,
        messages: current.exchanges.messages.map((m) =>
          m.id === first.id ? { ...m, unreadBy: [] } : m,
        ),
      },
    };
    await advance(3000);
    expect(lines()).toEqual(['1 événement, lis get_events']);
  });
});

describe('a prompt that holds something (FR-014, SC-003)', () => {
  it('Given a busy prompt, When an action event arrives, Then nothing is typed, the user is told at 2 min, and the pointer comes once the prompt is empty', async () => {
    busy = true;
    push();
    await advance(5000);
    expect(typed).toEqual([]);
    // 2 minutes from the event, at the latest 2 minutes from the moment the pointer is held.
    await advance(114_999);
    expect(notices).toEqual([]);
    await advance(6000);
    expect(notices).toEqual([{ agentId: LEAD, notice: 'input' }]);
    await advance(600_000);
    expect(notices).toHaveLength(1);
    expect(typed).toEqual([]);

    busy = false;
    wake.agentChanged(LEAD);
    await advance(1);
    expect(lines()).toEqual(['1 événement, lis get_events']);
    expect(notices.at(-1)).toEqual({ agentId: LEAD, notice: null });
  });

  it('Given a busy prompt, When the user empties it before 2 min, Then the pointer is typed and no notice was ever raised', async () => {
    busy = true;
    push();
    await advance(60_000);
    busy = false;
    wake.agentChanged(LEAD);
    await advance(1);
    expect(lines()).toEqual(['1 événement, lis get_events']);
    await advance(600_000);
    expect(notices.filter((n) => n.notice === 'input')).toEqual([]);
  });

  it('Given a busy prompt, When agentChanged is called and it is still busy, Then nothing is typed', async () => {
    busy = true;
    push();
    await advance(5000);
    wake.agentChanged(LEAD);
    await advance(1000);
    expect(typed).toEqual([]);
  });
});

describe('the cap of 20 wakes an hour (FR-016, R7)', () => {
  const fillCap = async () => {
    for (let i = 0; i < 20; i++) {
      push();
      await advance(5000);
    }
    expect(typed).toHaveLength(20);
  };

  it('Given 20 wakes in the hour, When another action arrives, Then it is held with one single notice, and the pointer comes after the hour', async () => {
    await fillCap();
    push();
    await advance(5000);
    expect(typed).toHaveLength(20);
    expect(notices).toEqual([{ agentId: LEAD, notice: 'cap' }]);

    push();
    await advance(5000);
    expect(typed).toHaveLength(20);
    expect(notices.filter((n) => n.notice === 'cap')).toHaveLength(1);

    // The oldest wake (at 5 000 ms) leaves the hour at 3 605 000 ms; the check runs every 30 s at
    // most. Now: 110 000 ms.
    await advance(3_490_000);
    expect(typed).toHaveLength(20);
    await advance(40_000);
    expect(typed).toHaveLength(21);
    expect(lines().at(-1)).toBe('2 événements, lis get_events');
    expect(notices.at(-1)).toEqual({ agentId: LEAD, notice: null });
  });

  it('Given the cap is reached, When the hour goes by with nothing held, Then no timer is left running', async () => {
    await fillCap();
    await advance(3_700_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given the cap is reached for one agent, When another agent gets an event, Then the other one is woken', async () => {
    current = { ...current, agents: [...current.agents, agent(3, 'spec')] };
    await fillCap();
    push('report', 'action', uuid(3));
    await advance(5000);
    expect(typed.at(-1)).toEqual({ agentId: uuid(3), line: '1 événement, lis get_events' });
  });
});

describe('the usage cut (FR-016, R7)', () => {
  it('Given a critical level for the CLI, When an action arrives, Then it is held, and the pointer comes once below the threshold', async () => {
    critical = true;
    push();
    await advance(5000);
    await advance(120_000);
    expect(typed).toEqual([]);
    critical = false;
    await advance(31_000);
    expect(lines()).toEqual(['1 événement, lis get_events']);
  });
});

describe('an urgent wake (FR-017)', () => {
  it('Given the cap reached and a critical level, When deliver({ urgent: true }) is called, Then the pointer is typed anyway', async () => {
    for (let i = 0; i < 20; i++) {
      push();
      await advance(5000);
    }
    critical = true;
    push();
    await advance(5000);
    expect(typed).toHaveLength(20);

    wake.deliver(LEAD, { urgent: true });
    await advance(1);
    expect(typed).toHaveLength(21);
    expect(lines().at(-1)).toBe('1 événement, lis get_events');
  });

  it('Given a busy prompt, When deliver({ urgent: true }) is called, Then nothing is typed: urgent skips the cap and the cut, not the prompt', async () => {
    busy = true;
    push();
    await advance(5000);
    wake.deliver(LEAD, { urgent: true });
    await advance(1000);
    expect(typed).toEqual([]);
  });

  it('Given the cap reached, When deliver is called without urgent, Then nothing is typed', async () => {
    for (let i = 0; i < 20; i++) {
      push();
      await advance(5000);
    }
    push();
    await advance(5000);
    wake.deliver(LEAD);
    await advance(1000);
    expect(typed).toHaveLength(20);
  });
});

describe('after a restart (FR-004, data-model « En mémoire »)', () => {
  it('Given a journal with unread action events and an empty memory, When the service restores, Then one pointer announces them, the info ones not counted', async () => {
    push();
    push();
    push('closed', 'info');
    wake.dispose();
    typed = [];
    // A new service: `announced` is empty.
    wake = await create();
    wake.restore();
    await advance(5000);
    expect(lines()).toEqual(['2 événements, lis get_events']);
  });

  it('Given nothing unread, When the service restores, Then nothing is typed', async () => {
    wake.restore();
    await advance(60_000);
    expect(typed).toEqual([]);
  });
});
