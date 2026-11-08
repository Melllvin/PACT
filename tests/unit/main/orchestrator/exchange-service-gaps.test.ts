import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeService } from '../../../../src/main/orchestrator/exchange-service';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 US3 — the edges of the journal: a workspace or an agent that is gone, a write that fails,
// two sends that race for the cap of a turn, a wait that is replaced while it reads.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const SPEC = uuid(3);
const DESIGN = uuid(4);

const agent = (n: number, role: Agent['role']): Agent =>
  ({
    id: uuid(n),
    workspaceId: 'w1',
    position: n,
    cliId: 'claude-code',
    role,
    state: 'awaiting-prompt',
  }) as Agent;

const base = (): Workspace =>
  ({
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [agent(1, 'orchestrator'), agent(2, 'dev'), agent(3, 'spec'), agent(4, 'design')],
    exchanges: { messages: [], escalations: [] },
  }) as unknown as Workspace;

let current: Workspace | undefined;
let failWrites: boolean;
let deferWrites: boolean;
let head: ((id: string) => Promise<string | null>) | undefined;
let service: ExchangeService;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
  current = base();
  failWrites = false;
  deferWrites = false;
  head = undefined;
  service = new ExchangeService({
    workspaces: {
      get: (id) => (current?.id === id ? current : undefined),
      list: () => (current ? [current] : []),
      update: async (_id, change) => {
        if (failWrites) throw new Error('disque plein');
        if (deferWrites) await Promise.resolve();
        if (!current) throw new Error('gone');
        current = change(current);
        return current;
      },
    },
    onChange: () => undefined,
    head: (id) => (head ? head(id) : Promise.resolve(null)),
    name: () => 'Claude Code',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const journal = () => current?.exchanges.messages ?? [];
const say = (from: string, to: string, text = 'Salut') => service.send('w1', { from, to, text });

describe('what is gone', () => {
  it('Given no such workspace, When an agent sends, Then it is told the workspace is not found', async () => {
    await expect(service.send('nope', { from: DEV, to: SPEC, text: 'a' })).rejects.toThrow(
      /Workspace introuvable/,
    );
  });

  it('Given a sender that has left the workspace, When it sends, Then it is told it is no longer there', async () => {
    await expect(say(uuid(99), SPEC)).rejects.toThrow(/plus dans ce workspace/);
  });

  it('Given the orchestrator asking itself, When it asks, Then it is refused', async () => {
    await expect(service.ask('w1', LEAD, 'Moi ?')).rejects.toThrow(/soi-même/);
  });

  it('Given a workspace closed while the commits are read, When the send goes on, Then it is told the workspace is not found', async () => {
    head = () => {
      current = undefined;
      return Promise.resolve(null);
    };
    await expect(say(DEV, SPEC)).rejects.toThrow(/Workspace introuvable/);
  });

  it('Given a head that cannot be read, When an agent sends, Then the message is delivered all the same', async () => {
    head = () => Promise.reject(new Error('git'));
    await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
  });

  it('Given unknown workspaces, When reading, forgetting or waiting, Then nothing is read and nothing breaks', async () => {
    expect(await service.read('nope', LEAD)).toEqual({ events: [], remaining: 0 });
    await service.forget('nope', DEV);
    const waiting = service.wait('nope', LEAD, undefined, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ events: [], timedOut: true });
  });
});

describe('the cap of a turn, raced', () => {
  it('Given 4 messages in the turn, When two sends start together, Then only one passes the cap of 5', async () => {
    for (let i = 0; i < 4; i++) await say(DEV, SPEC);
    const results = await Promise.allSettled([say(DEV, SPEC), say(DEV, DESIGN)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(journal()).toHaveLength(5);
  });
});

describe('a write that fails', () => {
  it('Given a first send, When the write fails, Then the count of the turn and of the pair are as before', async () => {
    failWrites = true;
    await expect(say(DEV, SPEC)).rejects.toThrow('disque plein');
    failWrites = false;
    for (let i = 0; i < 5; i++) await say(DEV, SPEC);
    expect(journal()).toHaveLength(5);
  });

  it('Given a pair already counted, When the next write fails, Then the previous count of the pair is kept', async () => {
    await say(DEV, SPEC);
    await say(SPEC, DEV);
    failWrites = true;
    await expect(say(DEV, SPEC)).rejects.toThrow('disque plein');
    failWrites = false;
    // 2 alternations kept: 4 more make the 6th change of sender, the 3rd round trip.
    await say(DEV, SPEC);
    await say(SPEC, DEV);
    await say(DEV, SPEC);
    expect(current?.exchanges.escalations).toHaveLength(0);
    await say(SPEC, DEV);
    expect(current?.exchanges.escalations).toHaveLength(1);
  });
});

describe('forget', () => {
  it('Given a pair that bounced, When one of its agents is forgotten, Then the pair starts again from zero', async () => {
    await say(DEV, SPEC);
    await say(SPEC, DEV);
    await say(DEV, SPEC);
    await service.forget('w1', SPEC);
    await say(DEV, DESIGN);
    expect(journal().filter((m) => m.unreadBy.includes(SPEC))).toEqual([]);
  });
});

describe('wait', () => {
  it('Given a wait on another workspace, When a message is recorded here, Then that wait is left alone', async () => {
    const waiting = service.wait('w2', LEAD, undefined, 1000);
    await service.record('w1', { from: 'pact', to: LEAD, kind: 'report', text: 'ici' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ events: [], timedOut: true });
  });

  it('Given a wait that is replaced while it reads, When the journal answers, Then the old wait takes nothing', async () => {
    await service.record('w1', { from: 'pact', to: LEAD, kind: 'report', text: 'a lire' });
    deferWrites = true;
    const first = service.wait('w1', LEAD, undefined, 1000);
    const second = service.wait('w1', LEAD, undefined, 1000);
    expect(await first).toMatchObject({ events: [], replaced: true });
    expect((await second).events.map((e) => e.summary)).toEqual(['a lire']);
  });

  it('Given a message of an agent without « about », When a wait names that agent, Then it is given', async () => {
    await service.record('w1', { from: DEV, to: LEAD, kind: 'message', text: 'du dev' });
    const result = await service.wait('w1', LEAD, [DEV], 1000);
    expect(result.events.map((e) => e.summary)).toEqual(['du dev']);
  });
});

describe('decide', () => {
  it('Given two escalations, When the user cuts one, Then the other stays pending', async () => {
    const escalation = (n: number, agents: [string, string]) => ({
      id: uuid(n),
      agents,
      lastMessageId: uuid(900),
      state: 'pending' as const,
      at: '2026-11-08T10:00:00.000Z',
    });
    if (!current) throw new Error('no workspace');
    current = {
      ...current,
      exchanges: {
        ...current.exchanges,
        escalations: [escalation(50, [DEV, SPEC]), escalation(51, [SPEC, DESIGN])],
      },
    };
    await service.decide('w1', uuid(50), 'cut');
    expect(current.exchanges.escalations.map((e) => e.state)).toEqual(['cut', 'pending']);
  });
});
