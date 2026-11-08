import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WakeService, eventsFileText } from '../../../../src/main/orchestrator/wake-service';
import type { ExchangeMessage } from '../../../../src/shared/exchanges';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 R11 — an agent without MCP reads a file that is written asynchronously; when the write
// fails, nothing is announced and the events stay to be announced again. An agent gone from the
// workspace holds nothing back.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);

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
let typed: string[];
let write: ReturnType<typeof vi.fn<(agent: Agent) => Promise<void>>>;
let wake: WakeService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
  const message = {
    id: uuid(1001),
    at: new Date().toISOString(),
    from: DEV,
    to: LEAD,
    type: 'action',
    kind: 'report',
    text: 'texte',
    unreadBy: [LEAD],
  } as ExchangeMessage;
  current = {
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [agent(1, 'orchestrator'), agent(2, 'dev')],
    exchanges: { messages: [message], escalations: [] },
  } as unknown as Workspace;
  typed = [];
  write = vi.fn<(agent: Agent) => Promise<void>>();
  wake = new WakeService({
    workspaces: {
      get: (id) => (id === current.id ? current : undefined),
      list: () => [current],
    },
    type: (_id, line) => {
      typed.push(line);
    },
    inputBusy: () => false,
    setNotice: () => undefined,
    usageCritical: () => false,
    file: { applies: () => true, write },
  });
});

afterEach(() => {
  wake.dispose();
  vi.useRealTimers();
});

describe('the file of events', () => {
  it('Given a write of the file that fails, When the agent is woken, Then nothing is typed and the next wake announces the events again', async () => {
    write.mockRejectedValueOnce(new Error('disque plein'));
    wake.deliver(LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(typed).toEqual([]);

    write.mockResolvedValueOnce();
    wake.deliver(LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('.pact/events.md');
  });
});

describe('an agent that is gone', () => {
  it('Given an agent no longer in any workspace, When it is woken, Then nothing is typed or written', async () => {
    current = { ...current, agents: [] };
    wake.deliver(LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(typed).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the text of the file of events', () => {
  it('Given a message of PACT and a message of an agent, When the text is made, Then the first is named PACT and the second by its sender', () => {
    const [first] = current.exchanges.messages;
    const text = eventsFileText([
      { ...(first as ExchangeMessage), from: 'pact', text: 'de PACT' },
      { ...(first as ExchangeMessage), from: DEV, text: 'du dev' },
    ]);
    expect(text).toContain('de PACT\n\nde PACT');
    expect(text).toContain(`de ${DEV}\n\ndu dev`);
  });
});
