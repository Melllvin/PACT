import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeService } from '../../../../src/main/orchestrator/exchange-service';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 T004 — the journal of a workspace: record, shared read, detail, wait, eviction, decisions
// (data-model.md, contracts/mcp-tools.md, research R2). The tests call `await` on every method:
// the journal may be written synchronously or not.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const SPEC = uuid(3);
const OTHER = uuid(4);

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
    agents: [agent(1, 'orchestrator'), agent(2, 'dev'), agent(3, 'spec')],
    exchanges: { messages: [], escalations: [] },
  }) as unknown as Workspace;

let current: Workspace;
let changes: unknown[];
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
    onChange: (_workspaceId: string, exchanges: unknown) => changes.push(exchanges),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
  current = base();
  changes = [];
  service = create();
});

afterEach(() => {
  vi.useRealTimers();
});

const journal = () => current.exchanges.messages;
const rejects = (call: () => unknown) => expect(Promise.resolve().then(call)).rejects.toThrow();

/** A report of `about` for `to`, as PACT writes it. */
const note = (text: string, over: Record<string, unknown> = {}) =>
  service.record('w1', { from: 'pact', to: LEAD, about: DEV, kind: 'report', text, ...over });

describe('record', () => {
  it('writes the message to the journal of the workspace, typed, unread by its recipient', async () => {
    const saved = await note('Fait');
    expect(journal()).toHaveLength(1);
    expect(journal()[0]).toMatchObject({
      id: saved.id,
      from: 'pact',
      to: LEAD,
      about: DEV,
      kind: 'report',
      type: 'action',
      text: 'Fait',
      unreadBy: [LEAD],
    });
    expect(Date.parse(journal()[0]?.at ?? '')).toBe(Date.parse('2026-11-06T10:00:00.000Z'));
  });

  it('types an event by its kind: turn-finished is info', async () => {
    await note('', { kind: 'turn-finished', state: 'done' });
    expect(journal()[0]).toMatchObject({ type: 'info', kind: 'turn-finished', state: 'done' });
  });

  it('announces the journal each time it changes (workspace:exchanges)', async () => {
    await note('Un');
    await note('Deux');
    expect(changes).toHaveLength(2);
    expect(changes.at(-1)).toMatchObject({ messages: [{ text: 'Un' }, { text: 'Deux' }] });
  });

  it('tells the listeners of onRecorded what was recorded, for the wake', async () => {
    const heard: unknown[] = [];
    service.onRecorded((workspaceId, recorded) => heard.push([workspaceId, recorded.kind]));
    await note('Fait');
    expect(heard).toEqual([['w1', 'report']]);
  });

  it('cuts an event of PACT to 2000 characters, and refuses a message over 500 or an instruction over 8000', async () => {
    await note('x'.repeat(5000));
    expect(journal()[0]?.text).toHaveLength(2000);
    await rejects(() =>
      service.record('w1', { from: DEV, to: SPEC, kind: 'message', text: 'm'.repeat(501) }),
    );
    await rejects(() =>
      service.record('w1', { from: 'pact', to: DEV, kind: 'instruction', text: 'i'.repeat(8001) }),
    );
    const long = 'i'.repeat(8000);
    await service.record('w1', { from: 'pact', to: DEV, kind: 'instruction', text: long });
    expect(journal().at(-1)?.text).toBe(long);
    expect(journal()).toHaveLength(2);
  });

  it('refuses a kind out of the closed list', async () => {
    await rejects(() => note('x', { kind: 'pull-request-comment' }));
    expect(journal()).toEqual([]);
  });
});

describe('read', () => {
  it('gives the 20 most recent unread, a summary of 200 characters at most, and what remains', async () => {
    for (let n = 1; n <= 25; n++) await note(`${String(n)} ${'x'.repeat(400)}`);
    const first = await service.read('w1', LEAD);
    expect(first.events).toHaveLength(20);
    expect(first.remaining).toBe(5);
    for (const event of first.events) expect(event.summary.length).toBeLessThanOrEqual(200);
    const recent = journal()
      .slice(-20)
      .map((m) => m.id);
    expect(first.events.map((e) => e.id).sort()).toEqual([...recent].sort());
  });

  it('gives each event once: the reader leaves unreadBy, and a second read has what was left', async () => {
    for (let n = 1; n <= 25; n++) await note(`n${String(n)}`);
    const first = await service.read('w1', LEAD);
    const second = await service.read('w1', LEAD);
    expect(second.events).toHaveLength(5);
    expect(second.remaining).toBe(0);
    const seen = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(seen).size).toBe(25);
    expect((await service.read('w1', LEAD)).events).toEqual([]);
    expect(journal().every((m) => !m.unreadBy.includes(LEAD))).toBe(true);
  });

  it('gives an event the fields of get_events', async () => {
    await note('Fait', { kind: 'turn-finished', state: 'done' });
    const [event] = (await service.read('w1', LEAD)).events;
    expect(event).toMatchObject({
      from: 'pact',
      about: DEV,
      type: 'info',
      kind: 'turn-finished',
      state: 'done',
      summary: 'Fait',
    });
    expect(typeof event?.id).toBe('string');
    expect(typeof event?.at).toBe('string');
    expect(event).not.toHaveProperty('text');
  });

  it('shows a reader only what is addressed to it, and leaves the others unread', async () => {
    await note('pour le lead');
    await note('pour le dev', { to: DEV });
    expect((await service.read('w1', DEV)).events.map((e) => e.summary)).toEqual(['pour le dev']);
    expect(journal().find((m) => m.text === 'pour le lead')?.unreadBy).toEqual([LEAD]);
    expect((await service.read('w1', OTHER)).events).toEqual([]);
  });

  it('keeps the unread across a reload of the service: the state is the workspace’s', async () => {
    await note('avant le redémarrage');
    service = create();
    expect((await service.read('w1', LEAD)).events.map((e) => e.summary)).toEqual([
      'avant le redémarrage',
    ]);
  });
});

describe('detail', () => {
  it('gives the whole text to the sender, the recipient and the orchestrator, and changes nothing to the reading', async () => {
    const text = `${'long '.repeat(300)}fin`;
    const { id } = await service.record('w1', {
      from: DEV,
      to: SPEC,
      kind: 'message',
      text: 'court',
      unreadBy: [SPEC, LEAD],
    });
    const long = await service.record('w1', {
      from: 'pact',
      to: DEV,
      kind: 'instruction',
      text,
    });
    for (const reader of [DEV, SPEC, LEAD]) {
      expect((await service.detail('w1', reader, id)).text).toBe('court');
    }
    expect((await service.detail('w1', DEV, long.id)).text).toBe(text);
    expect(journal().find((m) => m.id === long.id)?.unreadBy).toEqual([DEV]);
  });

  it('refuses a reader that is neither the sender, the recipient nor the orchestrator', async () => {
    const { id } = await service.record('w1', { from: DEV, to: SPEC, kind: 'message', text: 'a' });
    await rejects(() => service.detail('w1', OTHER, id));
  });

  it('refuses an unknown message', async () => {
    await rejects(() => service.detail('w1', LEAD, uuid(999)));
  });
});

describe('eviction at 500', () => {
  it('drops the oldest message read by everyone first', async () => {
    const unread = await service.record('w1', { from: 'pact', to: DEV, kind: 'report', text: 'u' });
    const read = await note('lu');
    await service.read('w1', LEAD);
    for (let n = 0; n < 498; n++) await note('plein', { to: DEV });
    expect(journal()).toHaveLength(500);
    await note('de trop', { to: DEV });
    expect(journal()).toHaveLength(500);
    expect(journal().some((m) => m.id === read.id)).toBe(false);
    expect(journal().some((m) => m.id === unread.id)).toBe(true);
  });

  it('drops the oldest when none was read', async () => {
    const first = await note('premier', { to: DEV });
    for (let n = 0; n < 500; n++) await note('plein', { to: DEV });
    expect(journal()).toHaveLength(500);
    expect(journal().some((m) => m.id === first.id)).toBe(false);
    expect(journal().at(-1)?.text).toBe('plein');
  });
});

describe('wait', () => {
  it('gives the unread at once', async () => {
    await note('déjà là');
    const result = await service.wait('w1', LEAD, undefined, 1000);
    expect(result).toMatchObject({ timedOut: false, remaining: 0 });
    expect(result.events.map((e) => e.summary)).toEqual(['déjà là']);
  });

  it('ends at the next message', async () => {
    const waiting = service.wait('w1', LEAD, undefined, 30_000);
    await vi.advanceTimersByTimeAsync(2000);
    await note('arrivé');
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect(result.events.map((e) => e.summary)).toEqual(['arrivé']);
  });

  it('only gives the events of the agents asked for, and keeps the others unread', async () => {
    await note('du dev', { about: DEV });
    await note('du spec', { about: SPEC });
    const result = await service.wait('w1', LEAD, [SPEC], 1000);
    expect(result.events.map((e) => e.summary)).toEqual(['du spec']);
    expect((await service.read('w1', LEAD)).events.map((e) => e.summary)).toEqual(['du dev']);
  });

  it('gives back control after 60 s at most, whatever the delay asked', async () => {
    const waiting = service.wait('w1', LEAD, undefined, 600_000);
    await vi.advanceTimersByTimeAsync(59_999);
    let ended = false;
    void waiting.then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({ events: [], timedOut: true });
  });

  it('gives at most 20 events of 200 characters, and says what remains (SC-008)', async () => {
    for (let n = 1; n <= 100; n++) await note(`${String(n)} ${'t'.repeat(7000)}`);
    const result = await service.wait('w1', LEAD, undefined, 1000);
    expect(result.events).toHaveLength(20);
    expect(result.remaining).toBe(80);
    expect(JSON.stringify(result.events).length).toBeLessThan(20 * 700);
    for (const event of result.events) expect(event.summary.length).toBeLessThanOrEqual(200);
  });

  it('is one wait at a time: the next replaces the first, which ends empty', async () => {
    const first = service.wait('w1', LEAD, undefined, 30_000);
    const second = service.wait('w1', LEAD, undefined, 30_000);
    expect(await first).toMatchObject({ events: [], timedOut: false, replaced: true });
    await note('pour la seconde');
    expect((await second).events).toHaveLength(1);
  });
});

describe('cancelWait', () => {
  it('ends the wait of an orchestrator that restarts, replaced', async () => {
    const waiting = service.wait('w1', LEAD, undefined, 30_000);
    service.cancelWait(LEAD);
    expect(await waiting).toMatchObject({ events: [], timedOut: false, replaced: true });
  });
});

describe('decide', () => {
  const pair = [DEV, SPEC].sort();
  const escalated = async () => {
    const last = await service.record('w1', { from: DEV, to: SPEC, kind: 'message', text: 'a' });
    current = {
      ...current,
      exchanges: {
        ...current.exchanges,
        escalations: [
          {
            id: uuid(50),
            agents: pair as [string, string],
            lastMessageId: last.id,
            state: 'pending',
            at: '2026-11-06T10:00:00.000Z',
          },
        ],
      },
    };
    changes.length = 0;
  };

  it('removes the escalation on « resume »', async () => {
    await escalated();
    await service.decide('w1', uuid(50), 'resume');
    expect(current.exchanges.escalations).toEqual([]);
    expect(changes).not.toHaveLength(0);
  });

  it('keeps it, cut, on « cut »', async () => {
    await escalated();
    await service.decide('w1', uuid(50), 'cut');
    expect(current.exchanges.escalations).toMatchObject([{ id: uuid(50), state: 'cut' }]);
  });

  it('refuses an escalation that does not exist', async () => {
    await rejects(() => service.decide('w1', uuid(51), 'resume'));
  });
});

describe('forget', () => {
  it('takes a closed agent out of every unreadBy', async () => {
    await note('pour le dev', { to: DEV });
    await service.record('w1', {
      from: DEV,
      to: SPEC,
      kind: 'message',
      text: 'copie',
      unreadBy: [SPEC, DEV, LEAD],
    });
    await service.forget('w1', DEV);
    expect(journal().flatMap((m) => m.unreadBy)).not.toContain(DEV);
    expect(journal().at(-1)?.unreadBy).toEqual([SPEC, LEAD]);
  });
});
