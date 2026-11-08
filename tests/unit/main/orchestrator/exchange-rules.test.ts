import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeMessage, Exchanges } from '../../../../src/shared/exchanges';
import type { Agent, Workspace } from '../../../../src/shared/model';

// 007 T040 — the rules of the exchanges between agents (spec US3 sc.1 to 6 and 11, FR-001 to FR-007,
// data-model « ExchangeEscalation », research R10, contracts/mcp-tools.md « Matrice »).
//
// API fixed here for the dev (see the report, « API fixées »), on `ExchangeService`:
//   new ExchangeService({ workspaces, onChange, head?, name? })
//     head(agentId): Promise<string | null>   the commit the worktree of the agent is at (R10); a
//                                             change of it, for one of the two agents of a pair, since
//                                             the last message of that pair, puts its count at zero
//     name(cliId): string                     « Claude Code »: lets `to` be « Claude Code 3 »
//   send(workspaceId, { from, to, text, type? }): Promise<{ message, warning? }>
//     A `message` of `from` to `to` (an id, or the displayed name « <CLI> <number> »). Refuses, by
//     rejecting with an `IpcFailure('INVALID_INPUT', reason)` whose message holds the reason, and
//     records NOTHING, in the cases of `canSend`, an unknown recipient, an empty text, a text over
//     500 characters, a 6th message of the turn, a pair in escalation or cut.
//   ask(workspaceId, from, text): Promise<{ message, warning? }>
//     A `question` of `from` to the orchestrator; same refusals (no orchestrator, empty, long, the
//     cap of the turn), but an orchestrator in error does not refuse it: `warning` says so.
//   resetTurn(agentId): void   the agent started or ended a turn (any passage to or from `working`):
//                              its count of messages for the turn goes back to zero
//   `warning` is a non-empty sentence: it holds « erreur » for a recipient in error and « ferm » for a
//   closed one. The message is in the journal in both cases.
// A round trip is an aller and its retour: A→B then B→A. The 3rd retour is the 6th message of the
// alternation: it is delivered, it opens the escalation (`lastMessageId` is that message), and every
// message of the pair after it is refused. Several messages in the same direction add nothing.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const SPEC = uuid(3);
const DESIGN = uuid(4);
const TEST = uuid(5);
const GONE = uuid(9);

const agent = (n: number, role: Agent['role'], state: Agent['state'] = 'working'): Agent =>
  ({
    id: uuid(n),
    workspaceId: 'w1',
    position: n,
    cliId: 'claude-code',
    role,
    state,
  }) as Agent;

const base = (): Workspace =>
  ({
    id: 'w1',
    path: '/w',
    name: 'w',
    mainBranch: 'main',
    agents: [
      agent(1, 'orchestrator'),
      agent(2, 'dev'),
      agent(3, 'spec'),
      agent(4, 'design'),
      agent(5, 'test'),
    ],
    exchanges: { messages: [], escalations: [] },
  }) as unknown as Workspace;

type Sent = { message: ExchangeMessage; warning?: string };
type Rules = {
  send(
    workspaceId: string,
    input: { from: string; to: string; text: string; type?: 'action' | 'info' },
  ): Promise<Sent>;
  ask(workspaceId: string, from: string, text: string): Promise<Sent>;
  resetTurn(agentId: string): void;
  decide(workspaceId: string, escalationId: string, decision: 'resume' | 'cut'): Promise<void>;
  forget(workspaceId: string, agentId: string): Promise<void>;
  onRecorded(listener: (workspaceId: string, message: ExchangeMessage) => void): void;
};
type Options = {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  onChange: (workspaceId: string, exchanges: Exchanges) => void;
  head?: (agentId: string) => Promise<string | null>;
  name?: (cliId: string) => string;
};
type Module = { ExchangeService: new (options: Options) => Rules };

const modulePath = '../../../../src/main/orchestrator/exchange-service';
const load = () => import(/* @vite-ignore */ modulePath) as Promise<Module>;

let current: Workspace;
let changes: Exchanges[];
let heads: Record<string, string>;
let service: Rules;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00.000Z'));
  current = base();
  changes = [];
  heads = {};
  const { ExchangeService } = await load();
  service = new ExchangeService({
    workspaces: {
      get: (id) => (id === current.id ? current : undefined),
      list: () => [current],
      update: (_id, change) => {
        current = change(current);
        return Promise.resolve(current);
      },
    },
    onChange: (_workspaceId, exchanges) => changes.push(exchanges),
    head: (id) => Promise.resolve(heads[id] ?? null),
    name: () => 'Claude Code',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const journal = () => current.exchanges.messages;
const escalations = () => current.exchanges.escalations;
const say = (from: string, to: string, text = 'Salut') => service.send('w1', { from, to, text });
const setState = (id: string, state: Agent['state']) => {
  current = {
    ...current,
    agents: current.agents.map((a) => (a.id === id ? { ...a, state } : a)),
  };
};

/** The refusal, with its reason; nothing is recorded or announced. */
const refused = async (call: Promise<unknown>, reason: RegExp) => {
  const before = journal().length;
  const announced = changes.length;
  await expect(call).rejects.toThrow(reason);
  expect(journal()).toHaveLength(before);
  expect(changes).toHaveLength(announced);
};

/** The notices PACT wrote to the orchestrator about a pair (R3: `action`, the agents named). */
const pactNotices = (kind: 'exchange-escalated' | 'exchange-decided') =>
  journal().filter((m) => m.kind === kind);
const expectNotice = (
  kind: 'exchange-escalated' | 'exchange-decided',
  count: number,
  named: string[] = ['Claude Code 2', 'Claude Code 3'],
) => {
  const notices = pactNotices(kind);
  expect(notices).toHaveLength(count);
  for (const notice of notices) {
    expect(notice).toMatchObject({ from: 'pact', to: LEAD, type: 'action', kind });
    for (const name of named) expect(notice.text).toContain(name);
  }
};

/** `n` alternating messages A→B, B→A, A→B… */
const alternate = async (a: string, b: string, n: number) => {
  for (let i = 0; i < n; i++) await (i % 2 === 0 ? say(a, b) : say(b, a));
};

describe('send applies the matrix canSend (FR-001, FR-007, US3 sc.5 and sc.11)', () => {
  it('Given a dev and a design agent, When one writes to the other, Then it passes and is in the journal', async () => {
    const { message } = await say(DEV, DESIGN, 'Le gabarit est prêt');
    expect(journal()).toHaveLength(1);
    expect(journal()[0]).toMatchObject({
      id: message.id,
      from: DEV,
      to: DESIGN,
      kind: 'message',
      type: 'action',
      text: 'Le gabarit est prêt',
    });
    expect(Date.parse(message.at)).toBe(Date.parse('2026-11-08T10:00:00.000Z'));
  });

  it('Given an orchestrator, When it writes to a tester, Then the message passes', async () => {
    await say(LEAD, TEST, 'Écris les tests');
    expect(journal()[0]).toMatchObject({ from: LEAD, to: TEST });
  });

  it('Given a dev, When it writes to the tester, Then it is refused: only the verdict and git pass', async () => {
    await refused(say(DEV, TEST), /verdict/i);
  });

  it('Given a spec agent, When it writes to the tester, Then it is refused towards the orchestrator', async () => {
    await refused(say(SPEC, TEST), /orchestrateur/i);
  });

  it.each([
    ['a tester to a dev', TEST, DEV],
    ['a tester to the orchestrator', TEST, LEAD],
    ['a tester to a spec agent', TEST, SPEC],
  ])(
    'Given %s, When it writes, Then it is refused and the reason is ask_orchestrator',
    async (_n, from, to) => {
      await refused(say(from, to), /ask_orchestrator/);
    },
  );

  it('Given a dev, When it writes to the orchestrator, Then it is refused towards ask_orchestrator', async () => {
    await refused(say(DEV, LEAD), /ask_orchestrator/);
  });

  it('Given anyone, When it writes to itself, Then it is refused', async () => {
    await refused(say(DEV, DEV), /soi-même/i);
  });

  it('Given an id that is not in the workspace, When a message is sent to it, Then it is refused', async () => {
    await refused(say(DEV, GONE), /.+/);
  });

  it('Given a workspace without orchestrator, When an agent writes, Then it is refused with its reason', async () => {
    current = { ...current, agents: current.agents.filter((a) => a.role !== 'orchestrator') };
    await refused(say(DEV, SPEC), /orchestrateur/i);
  });

  it('Given an orchestrator in error, When two agents write, Then it is not « no orchestrator »: the message passes', async () => {
    setState(LEAD, 'error');
    await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
  });

  it('Given the displayed name of the recipient, When a message is sent to « Claude Code 3 », Then it reaches that agent', async () => {
    await say(DEV, 'Claude Code 3');
    expect(journal()[0]?.to).toBe(SPEC);
  });

  it('Given a type chosen by the sender, When it is info, Then the message is info; by default it is action', async () => {
    await service.send('w1', { from: DEV, to: SPEC, text: 'FYI', type: 'info' });
    await say(DEV, SPEC);
    expect(journal().map((m) => m.type)).toEqual(['info', 'action']);
  });
});

describe('the bound of 500 characters (FR-002, US3 sc.3)', () => {
  it('Given a text of 501 characters, When it is sent, Then it is refused with the limit and nothing is transmitted', async () => {
    await refused(say(DEV, SPEC, 'x'.repeat(501)), /500/);
  });

  it('Given a text of exactly 500 characters, When it is sent, Then it passes whole', async () => {
    await say(DEV, SPEC, 'x'.repeat(500));
    expect(journal()[0]?.text).toHaveLength(500);
  });

  it('Given an empty text, When it is sent, Then it is refused', async () => {
    await refused(say(DEV, SPEC, ''), /.+/);
  });

  it('Given a question of 501 characters, When it is asked, Then it is refused too', async () => {
    await refused(service.ask('w1', DEV, 'y'.repeat(501)), /500/);
  });
});

describe('the cap of 5 messages per agent and per turn (FR-005, US3 sc.4)', () => {
  it('Given 5 messages in the turn, When a 6th is sent, Then it is refused with its reason, and nothing is transmitted', async () => {
    for (let i = 0; i < 5; i++) await say(DEV, SPEC);
    await refused(say(DEV, DESIGN), /5/);
  });

  it('Given the cap reached, When the turn changes, Then the count goes back to zero', async () => {
    for (let i = 0; i < 5; i++) await say(DEV, SPEC);
    service.resetTurn(DEV);
    await say(DEV, SPEC);
    expect(journal()).toHaveLength(6);
  });

  it('Given the cap reached by a dev, When a spec agent writes, Then it is not affected: the count is per agent', async () => {
    for (let i = 0; i < 5; i++) await say(DEV, DESIGN);
    await say(SPEC, DESIGN);
    expect(journal()).toHaveLength(6);
  });

  it('Given questions and messages, When they make 6 in the turn, Then ask_orchestrator and send_message share the cap', async () => {
    await service.ask('w1', DEV, 'Une ?');
    await service.ask('w1', DEV, 'Deux ?');
    await say(DEV, SPEC);
    await say(DEV, SPEC);
    await service.ask('w1', DEV, 'Cinq ?');
    await refused(service.ask('w1', DEV, 'Six ?'), /5/);
  });

  it('Given the orchestrator, When it sends 6 messages in a turn, Then the 6th is refused too', async () => {
    for (let i = 0; i < 5; i++) await say(LEAD, SPEC);
    await refused(say(LEAD, DEV), /5/);
  });

  it('Given a refused message, When the count is read, Then a refusal does not use up the cap', async () => {
    for (let i = 0; i < 5; i++) await expect(say(DEV, TEST)).rejects.toThrow();
    await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
  });
});

describe('the copy to the orchestrator (FR-004, US3 sc.1 and sc.2)', () => {
  it('Given two agents, When A writes to B, Then there is ONE message, for B, unread by B and by the orchestrator', async () => {
    await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
    expect(journal()[0]?.to).toBe(SPEC);
    expect([...(journal()[0]?.unreadBy ?? [])].sort()).toEqual([LEAD, SPEC]);
  });

  it('Given that copy, When the wake is told, Then the message is for B, so the orchestrator is not woken by it', async () => {
    const heard: ExchangeMessage[] = [];
    service.onRecorded((_workspaceId, message) => heard.push(message));
    await say(DEV, SPEC);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.to).toBe(SPEC);
  });

  it('Given the orchestrator writes to an agent, When it is recorded, Then there is no copy to itself', async () => {
    await say(LEAD, DEV);
    expect(journal()[0]?.unreadBy).toEqual([DEV]);
  });

  it('Given a dev, When it calls ask, Then the journal has an action question for the orchestrator, who is woken', async () => {
    const heard: ExchangeMessage[] = [];
    service.onRecorded((_workspaceId, message) => heard.push(message));
    const { message } = await service.ask('w1', DEV, 'Quelle base ?');
    expect(journal()[0]).toMatchObject({
      id: message.id,
      from: DEV,
      to: LEAD,
      kind: 'question',
      type: 'action',
      text: 'Quelle base ?',
      unreadBy: [LEAD],
    });
    expect(heard.map((m) => m.to)).toEqual([LEAD]);
  });

  it('Given a workspace without orchestrator, When an agent asks, Then it is refused', async () => {
    current = { ...current, agents: current.agents.filter((a) => a.role !== 'orchestrator') };
    await refused(service.ask('w1', DEV, 'Quelqu’un ?'), /orchestrateur/i);
  });

  it('Given a tester, When it asks the orchestrator, Then it passes: it is its only way', async () => {
    await service.ask('w1', TEST, 'Le critère 3 est flou');
    expect(journal()[0]).toMatchObject({ from: TEST, to: LEAD, kind: 'question' });
  });

  it('Given the journal changes, When a message is recorded, Then workspace:exchanges is told once with it', async () => {
    await say(DEV, SPEC);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.messages).toHaveLength(1);
  });
});

describe('a recipient that is closed or in error (journal and warning)', () => {
  it('Given a recipient in error, When a message is sent, Then it is in the journal and the answer warns', async () => {
    setState(SPEC, 'error');
    const sent = await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
    expect(sent.warning).toMatch(/erreur/i);
  });

  it('Given a closed recipient, When a message is sent, Then it is in the journal and the answer warns', async () => {
    setState(SPEC, 'closed');
    const sent = await say(DEV, SPEC);
    expect(journal()).toHaveLength(1);
    expect(sent.warning).toMatch(/ferm/i);
  });

  it('Given a recipient that works, When a message is sent, Then there is no warning', async () => {
    const sent = await say(DEV, SPEC);
    expect(sent.warning).toBeUndefined();
  });

  it('Given an orchestrator in error, When an agent asks, Then the question is kept and the answer says so', async () => {
    setState(LEAD, 'error');
    const sent = await service.ask('w1', DEV, 'Et maintenant ?');
    expect(journal()).toHaveLength(1);
    expect(sent.warning).toMatch(/erreur/i);
  });
});

describe('3 round trips without a commit (FR-006, US3 sc.6)', () => {
  it('Given 5 alternating messages, When they are read, Then there is no escalation yet', async () => {
    await alternate(DEV, SPEC, 5);
    expect(escalations()).toEqual([]);
  });

  it('Given 6 alternating messages, When the 3rd retour is sent, Then it is delivered and the escalation names the pair and the last exchange', async () => {
    await alternate(DEV, SPEC, 6);
    // The 6 messages and the notice exchange-escalated for the orchestrator.
    expect(journal()).toHaveLength(7);
    expectNotice('exchange-escalated', 1);
    service.resetTurn(DEV);
    await refused(say(DEV, SPEC, 'Encore'), /escalad|boucle|décision/i);
    expect(journal().some((m) => m.text === 'Encore')).toBe(false);
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({
      agents: [DEV, SPEC].sort(),
      lastMessageId: journal()[5]?.id,
      state: 'pending',
    });
    expect(changes.at(-1)?.escalations).toHaveLength(1);
  });

  it('Given the escalation, When either agent writes to the other, Then it is refused until the decision', async () => {
    await alternate(DEV, SPEC, 6);
    service.resetTurn(DEV);
    service.resetTurn(SPEC);
    await refused(say(DEV, SPEC), /escalad|boucle|décision/i);
    await refused(say(SPEC, DEV), /escalad|boucle|décision/i);
  });

  it('Given the escalation, When the pair writes to others, Then the other exchanges go on', async () => {
    await alternate(DEV, SPEC, 6);
    service.resetTurn(DEV);
    service.resetTurn(SPEC);
    await say(DEV, DESIGN);
    await say(SPEC, DESIGN);
    await say(DESIGN, DEV);
    await service.ask('w1', DEV, 'Je suis bloqué');
    // The 10 messages and the notice exchange-escalated.
    expect(journal()).toHaveLength(11);
    expectNotice('exchange-escalated', 1);
    await refused(say(DEV, SPEC, 'Encore'), /escalad|boucle|décision/i);
    expect(journal().some((m) => m.text === 'Encore')).toBe(false);
  });

  it('Given messages in the same direction, When they are many, Then they are not round trips', async () => {
    for (let i = 0; i < 3; i++) await say(DEV, SPEC);
    await say(SPEC, DEV);
    service.resetTurn(DEV);
    for (let i = 0; i < 3; i++) await say(DEV, SPEC);
    expect(escalations()).toEqual([]);
  });

  it('Given the orchestrator in a pair, When a question and its answer make 3 round trips, Then it escalates too', async () => {
    for (let i = 0; i < 3; i++) {
      await service.ask('w1', DEV, `Question ${String(i)}`);
      await say(LEAD, DEV, `Réponse ${String(i)}`);
      service.resetTurn(DEV);
      service.resetTurn(LEAD);
    }
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]?.agents).toEqual([LEAD, DEV].sort());
  });

  it('Given a new commit of one of the two, When the exchange goes on, Then the count starts again from zero', async () => {
    heads[DEV] = 'aaa';
    heads[SPEC] = 'bbb';
    await alternate(DEV, SPEC, 4);
    heads[DEV] = 'ccc'; // a new commit of the dev
    await alternate(DEV, SPEC, 5);
    expect(escalations()).toEqual([]);
    // … and 3 round trips without a commit after that one still escalate.
    service.resetTurn(DEV);
    service.resetTurn(SPEC);
    await say(SPEC, DEV);
    expect(escalations()).toHaveLength(1);
  });

  it('Given a new commit of the other agent of the pair, When the exchange goes on, Then it starts again from zero too', async () => {
    heads[DEV] = 'aaa';
    heads[SPEC] = 'bbb';
    await alternate(DEV, SPEC, 4);
    heads[SPEC] = 'ddd';
    await alternate(DEV, SPEC, 5);
    expect(escalations()).toEqual([]);
  });

  it('Given two pairs at 2 round trips each, When they are read, Then the counts are per pair: no escalation', async () => {
    await alternate(DEV, SPEC, 4);
    await alternate(DEV, DESIGN, 4);
    expect(escalations()).toEqual([]);
  });
});

describe('the decision of the user on an escalation (FR-006)', () => {
  const escalated = async () => {
    await alternate(DEV, SPEC, 6);
    service.resetTurn(DEV);
    service.resetTurn(SPEC);
    return escalations()[0]?.id ?? '';
  };

  it('Given « Laisser reprendre », When resume is decided, Then the escalation is gone and the pair may write again', async () => {
    const id = await escalated();
    await refused(say(DEV, SPEC, 'Trop tôt'), /escalad|boucle|décision/i);
    await service.decide('w1', id, 'resume');
    expect(escalations()).toEqual([]);
    await say(DEV, SPEC);
    // 6 messages, the notices exchange-escalated and exchange-decided, and the new message.
    expect(journal()).toHaveLength(9);
    expectNotice('exchange-escalated', 1);
    expectNotice('exchange-decided', 1);
    expect(journal().some((m) => m.text === 'Trop tôt')).toBe(false);
  });

  it('Given a resumed pair, When it writes 2 round trips more, Then the count had been reset: no new escalation', async () => {
    const id = await escalated();
    await service.decide('w1', id, 'resume');
    await alternate(DEV, SPEC, 4);
    expect(escalations()).toEqual([]);
  });

  it('Given « Couper », When cut is decided, Then the escalation is kept as cut and the pair stays refused', async () => {
    const id = await escalated();
    await service.decide('w1', id, 'cut');
    expect(escalations()).toHaveLength(1);
    expect(escalations()[0]).toMatchObject({ id, state: 'cut' });
    await refused(say(DEV, SPEC), /.+/);
  });

  it('Given a cut pair, When one of the two agents is closed, Then the escalation goes and the other keeps no refusal', async () => {
    const id = await escalated();
    await service.decide('w1', id, 'cut');
    await service.forget('w1', SPEC);
    expect(escalations()).toEqual([]);
  });
});
