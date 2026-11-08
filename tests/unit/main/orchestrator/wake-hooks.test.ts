import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeKind, ExchangeMessage } from '../../../../src/shared/exchanges';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 T032 — the wake of an agent in the middle of its turn, by the reply of a hook (research R1,
// R4, R7; contracts/hooks.md « Handler »). Fake clock only: no real wait.
//
// API fixed here for the dev (see the report, « API fixées »):
//   wake.takeForHook(agentId, point: 'tool' | 'stop'): string | null
//     The pointer the reply of the hook carries, or null (the hook answers nothing). When it gives a
//     pointer, the messages it announces are marked announced and the wake counts for the cap.
//     - 'tool'  (PostToolUse) respects the window of 5 s: null while the window of the first
//               unannounced event is open, the pointer once it is over;
//     - 'stop'  (Stop) empties the window: the pointer at once;
//     - both check the cap of 20 wakes an hour and the usage cut (null, and the notice 'cap' once);
//     - null when nothing is left to announce (the second Stop), for an unknown agent, and for events
//       of type `info` or written for another agent.
//     It never calls `type`: a reply of a hook writes nothing in the terminal (Q10).
// The agent is `working`, as it is when its hook fires. The module is loaded in `beforeEach`, so
// that each test fails on its own while `takeForHook` is absent.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);

type Notice = 'input' | 'cap' | null;
type WakeLike = {
  notify(workspaceId: string, message: ExchangeMessage): void;
  agentChanged(agentId: string): void;
  takeForHook?: (agentId: string, point: 'tool' | 'stop') => string | null;
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
    state: 'working',
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

const setState = (id: string, state: Agent['state']) => {
  current = {
    ...current,
    agents: current.agents.map((a) => (a.id === id ? { ...a, state } : a)),
  };
};

/** The reply of a hook: the pointer, or null. Fails on the missing method, not on a type error. */
const take = (point: 'tool' | 'stop', id = LEAD): string | null => {
  if (typeof wake.takeForHook !== 'function') throw new Error('WakeService.takeForHook is absent');
  return wake.takeForHook(id, point);
};
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

describe('PostToolUse: the window of 5 s is respected (FR-011)', () => {
  it('Given an action event in a window, When a tool ends before the 5 s, Then the hook answers nothing', async () => {
    push();
    expect(take('tool')).toBeNull();
    await advance(4999);
    expect(take('tool')).toBeNull();
    expect(typed).toEqual([]);
  });

  it('Given an action event, When a tool ends once the 5 s are over, Then the hook carries the pointer and nothing is typed', async () => {
    push();
    await advance(5000);
    expect(take('tool')).toBe('1 événement, lis get_events');
    await advance(60_000);
    expect(typed).toEqual([]);
  });

  it('Given three events in the window, When the window is over, Then the one pointer announces 3', async () => {
    push();
    await advance(2000);
    push();
    await advance(2000);
    push();
    await advance(1000);
    expect(take('tool')).toBe('3 événements, lis get_events');
    expect(take('tool')).toBeNull();
  });

  it('Given an event announced, When a new one arrives, Then it opens its own window and a tool before its end gets nothing', async () => {
    push();
    await advance(5000);
    expect(take('tool')).toBe('1 événement, lis get_events');
    push();
    expect(take('tool')).toBeNull();
    await advance(4999);
    expect(take('tool')).toBeNull();
    await advance(1);
    expect(take('tool')).toBe('1 événement, lis get_events');
  });

  it('Given no event at all, When a tool ends, Then the hook answers nothing', () => {
    expect(take('tool')).toBeNull();
  });
});

describe('Stop: the window is emptied (R4)', () => {
  it('Given an event in the window, When the agent is about to stop, Then the pointer comes at once, without waiting for the 5 s', async () => {
    push();
    await advance(1000);
    expect(take('stop')).toBe('1 événement, lis get_events');
  });

  it('Given a turn without any tool, When it ends with an unread action event, Then Stop alone carries the pointer', () => {
    push();
    expect(take('stop')).toBe('1 événement, lis get_events');
  });

  it('Given the window emptied by Stop, When the 5 s pass and the agent then rests, Then nothing is typed and no timer is left', async () => {
    push();
    push();
    expect(take('stop')).toBe('2 événements, lis get_events');
    await advance(10_000);
    setState(LEAD, 'awaiting-prompt');
    wake.agentChanged(LEAD);
    await advance(60_000);
    expect(typed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Given a pointer sent by a tool, When Stop comes with nothing new, Then it answers nothing (no loop)', async () => {
    push();
    await advance(5000);
    expect(take('tool')).toBe('1 événement, lis get_events');
    expect(take('stop')).toBeNull();
  });
});

describe('everything announced: nothing more (R4 « Non-boucle »)', () => {
  it('Given a Stop that carried the pointer, When the second Stop comes, Then it answers nothing', () => {
    push();
    expect(take('stop')).toBe('1 événement, lis get_events');
    expect(take('stop')).toBeNull();
    expect(take('stop')).toBeNull();
  });

  it('Given every event announced, When a new event arrives, Then the next hook carries a pointer again, for that event only', () => {
    push();
    push();
    expect(take('stop')).toBe('2 événements, lis get_events');
    expect(take('stop')).toBeNull();
    push('verdict');
    expect(take('stop')).toBe('1 événement, lis get_events');
    expect(take('stop')).toBeNull();
  });

  it('Given events that were read, When Stop comes, Then the hook answers nothing', () => {
    push();
    markAllRead();
    expect(take('stop')).toBeNull();
  });
});

describe('what a hook never announces', () => {
  it('Given an info event only, When Stop comes, Then the hook answers nothing', () => {
    push('turn-finished', 'info');
    expect(take('stop')).toBeNull();
  });

  it('Given an event written for another agent, When Stop comes for this one, Then the hook answers nothing, and the other gets its own', () => {
    push('instruction', 'action', DEV);
    expect(take('stop', LEAD)).toBeNull();
    expect(take('stop', DEV)).toBe('1 événement, lis get_events');
  });

  it('Given an agent unknown to the workspaces, When its hook fires, Then the answer is null and nothing throws', () => {
    push();
    expect(take('stop', uuid(99))).toBeNull();
    expect(take('tool', uuid(99))).toBeNull();
  });
});

describe('a reply of a hook writes nothing in the terminal (Q10)', () => {
  it('Given a busy prompt, When a hook carries the pointer, Then the pointer is carried (no typing is involved) and nothing is typed', async () => {
    busy = true;
    push();
    expect(take('stop')).toBe('1 événement, lis get_events');
    push();
    await advance(5000);
    expect(take('tool')).toBe('1 événement, lis get_events');
    await advance(180_000);
    expect(typed).toEqual([]);
  });

  it('Given a pointer carried by a hook, When the agent rests afterwards, Then it is not typed a second time', async () => {
    push();
    expect(take('stop')).toBe('1 événement, lis get_events');
    setState(LEAD, 'done');
    wake.agentChanged(LEAD);
    await advance(30_000);
    expect(typed).toEqual([]);
  });
});

describe('the cap of 20 wakes an hour (FR-016, R7)', () => {
  it('Given 20 pointers carried by hooks in the hour, When a 21st event arrives, Then the hook answers nothing, once warned, and the pointer comes an hour later', async () => {
    for (let i = 0; i < 20; i++) {
      push();
      expect(take('stop')).toBe('1 événement, lis get_events');
      await advance(1000);
    }
    push();
    expect(take('stop')).toBeNull();
    expect(take('stop')).toBeNull();
    await advance(5000);
    expect(take('tool')).toBeNull();
    expect(notices.filter((n) => n.notice === 'cap')).toEqual([{ agentId: LEAD, notice: 'cap' }]);

    // The event is not lost: the hour passes, the window of the sliding hour lets it out.
    await advance(3_600_000);
    expect(take('stop')).toBe('1 événement, lis get_events');
    expect(notices.at(-1)).toEqual({ agentId: LEAD, notice: null });
    expect(typed).toEqual([]);
  });

  it('Given pointers typed and carried in the same hour, When together they reach 20, Then the cap counts both', async () => {
    // 10 wakes typed to the idle agent, one after the other…
    setState(LEAD, 'awaiting-prompt');
    for (let i = 0; i < 10; i++) {
      push();
      await advance(5000);
    }
    expect(typed).toHaveLength(10);
    // … then 10 carried by hooks, the agent being at work.
    setState(LEAD, 'working');
    for (let i = 0; i < 10; i++) {
      push();
      expect(take('stop')).toBe('1 événement, lis get_events');
    }
    push();
    expect(take('stop')).toBeNull();
  });
});

describe('the usage cut (FR-016, R7)', () => {
  it('Given the usage at critical, When a hook fires, Then it answers nothing; once the usage is back, Then the pointer comes, no event lost', async () => {
    critical = true;
    push();
    expect(take('stop')).toBeNull();
    await advance(5000);
    expect(take('tool')).toBeNull();
    expect(typed).toEqual([]);

    critical = false;
    expect(take('tool')).toBe('1 événement, lis get_events');
  });

  it('Given the usage at critical, When the cut ends and a Stop comes, Then the Stop carries the pointer', () => {
    critical = true;
    push();
    expect(take('stop')).toBeNull();
    critical = false;
    expect(take('stop')).toBe('1 événement, lis get_events');
  });
});
