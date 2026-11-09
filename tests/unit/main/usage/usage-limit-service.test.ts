import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../../../src/main/agents/auto-resume';
import { openStores, type Stores } from '../../../../src/main/persistence/store';
import type { Agent } from '../../../../src/shared/model';
import { clockTime, type UsageState, type UsageWindow } from '../../../../src/shared/usage';

/** `expect.objectContaining` typed as `unknown`, so it nests in an expected value. */
const has = (fields: object): unknown => expect.objectContaining(fields);

// 009 T015 — US1: the stop at a limit (research R4 to R7, R13; contracts/events.md « Messages du journal »,
// spec US1 sc.1 to 11, SC-001). The service has fake dependencies and a clock the test drives: no real wait.
//
// API fixed here for the dev (see the report, « API fixées »), `src/main/usage/usage-limit-service.ts`:
//   new UsageLimitService({ agents, exchanges, wake, stores, clock, autoResume, commitFrozen })
//     agents.accountAgents(cliId, account): Agent[]      AgentManager.accountAgents (R7)
//     agents.pause(agentId, pause): Promise<void>        AgentManager.pause (T022): `pause` holds what only the
//                                                        service knows (cliId, account, cause, windows, resumeAt,
//                                                        pausedAt); the manager adds midTurn, saved, closedQuestion
//                                                        and blocked
//     exchanges.record(workspaceId, input)               ExchangeService.record, from 'pact'
//     wake.deliver(agentId, { urgent: true })            WakeService.deliver
//     stores                                             the real stores: `stores.state` holds `usageStops`
//                                                        and `usageLimit` (saves, overrides)
//     clock                                              `Clock` of auto-resume.ts (R16)
//     autoResume(workspaceId): Promise<boolean>          whether the resume is scheduled (R8)
//     commitFrozen(agentId): boolean                     008 freezes the commit of the agent (R18)
//   service.onUsage(state: UsageState): Promise<void>    a `usage:state` of UsageService
//   service.turnFinished(agentId): Promise<void>         the agent ended its turn (T027)
//   service.launched(workspaceId, agents): Promise<void> agents were launched, whoever asked (O1)
//   service.usageHeld(cliId): boolean                    WakeOptions.usageHeld (R13)
//   service.pausedFor(cliId): UsagePause-like | null     the pause of an account of the CLI, for launch_agent (R12)
// The module is loaded in `beforeEach`, so that each test fails on its own while it is absent.

const START = '2030-01-01T09:00:00.000Z';
const RESET_5H = '2030-01-01T11:00:00.000Z';
const RESET_WEEK = '2030-01-05T09:00:00.000Z';
const NEXT_RESET_5H = '2030-01-01T16:00:00.000Z';

type Pause = {
  cliId: string;
  account: string;
  cause: 'threshold' | 'stale';
  windows: { id: string; label: string; percent: number; resetsAt: string | null }[];
  resumeAt: string | null;
  pausedAt: string;
};
type ServiceLike = {
  onUsage(state: UsageState): Promise<void>;
  turnFinished(agentId: string): Promise<void>;
  launched(workspaceId: string, agents: Agent[]): Promise<void>;
  usageHeld(cliId: string): boolean;
  pausedFor(cliId: string): Pause | null;
};
type ServiceOptions = {
  agents: {
    accountAgents(cliId: string, account: string): Agent[];
    pause(agentId: string, pause: Pause): Promise<void>;
  };
  exchanges: { record(workspaceId: string, input: Record<string, unknown>): Promise<unknown> };
  wake: { deliver(agentId: string, options?: { urgent?: boolean }): void };
  stores: Stores;
  clock: Clock;
  autoResume(workspaceId: string): Promise<boolean>;
  commitFrozen(agentId: string): boolean;
};
type ServiceModule = { UsageLimitService: new (options: ServiceOptions) => ServiceLike };

const modulePath = '../../../../src/main/usage/usage-limit-service';
const load = () => import(/* @vite-ignore */ modulePath) as Promise<ServiceModule>;

/** Time moves only when a test says so; due timers then run, in order. */
class TestClock implements Clock {
  private current = new Date(START);
  private readonly timers = new Set<{ at: number; run: () => void }>();

  now = () => new Date(this.current);

  setTimeout = (run: () => void, ms: number) => {
    const timer = { at: +this.current + ms, run };
    this.timers.add(timer);
    return timer;
  };

  clearTimeout = (timer: unknown) => {
    this.timers.delete(timer as { at: number; run: () => void });
  };

  async advance(ms: number) {
    const target = +this.current + ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.delete(due);
      this.current = new Date(Math.max(+this.current, due.at));
      due.run();
      await flush();
    }
    this.current = new Date(target);
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

const agent = (n: number, over: Partial<Agent> = {}): Agent =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    workspaceId: 'w1',
    position: n,
    cliId: 'claude-code',
    role: null,
    launchedBy: null,
    state: 'working',
    ...over,
  }) as Agent;

const window5h = (percent: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  id: 'five-hour',
  label: '5 h',
  usedPercent: percent,
  resetsAt: RESET_5H,
  minutes: 300,
  ...over,
});
const weekly = (percent: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  id: 'week',
  label: 'semaine',
  usedPercent: percent,
  resetsAt: RESET_WEEK,
  minutes: 10_080,
  ...over,
});

let root: string;
let stores: Stores;
let clock: TestClock;
let calls: string[];
let records: { workspaceId: string; input: Record<string, unknown> }[];
let delivered: { agentId: string; urgent: boolean }[];
let paused: string[];
let pauses: { agentId: string; pause: Pause }[];
let members: Record<string, Agent[]>;
let frozen: Set<string>;
let autoResumeOf: Record<string, boolean>;
let service: ServiceLike;

const key = (cliId: string, account: string) => `${cliId}/${account}`;

const state = (
  windows: UsageWindow[],
  { cliId = 'claude-code', account = 'default' } = {},
): UsageState => ({
  cliId,
  account,
  reading: { cliId, account, windows, readAt: clock.now().toISOString() },
  shares: [],
  level: 'ok',
});

const create = async () => {
  const { UsageLimitService } = await load();
  return new UsageLimitService({
    agents: {
      accountAgents: (cliId, account) =>
        (members[key(cliId, account)] ?? []).filter((a) => !paused.includes(a.id)),
      pause: (agentId, pause) => {
        calls.push(`pause:${agentId}`);
        pauses.push({ agentId, pause });
        paused.push(agentId);
        return Promise.resolve();
      },
    },
    exchanges: {
      record: (workspaceId, input) => {
        calls.push(`record:${String(input.kind)}:${String(input.to)}`);
        records.push({ workspaceId, input });
        return Promise.resolve({});
      },
    },
    wake: {
      deliver: (agentId, options) => {
        calls.push(`deliver:${agentId}`);
        delivered.push({ agentId, urgent: options?.urgent === true });
      },
    },
    stores,
    clock,
    autoResume: (workspaceId) => Promise.resolve(autoResumeOf[workspaceId] ?? true),
    commitFrozen: (agentId) => frozen.has(agentId),
  });
};

const A = agent(1);
const B = agent(2, { workspaceId: 'w2', state: 'awaiting-prompt' });
const CODEX = agent(3, { cliId: 'codex' });

const saveText = (label: string, percent: number, stop: number, jump = false) =>
  `Limite ${label} à ${String(percent)} % (arrêt à ${String(stop)} %). Committe maintenant ton travail en cours, en local${jump ? ', dans la minute' : ''} : git add puis git commit. Ne pousse rien : le push reste à la livraison. PACT arrêtera les agents de ce compte au seuil et les reprendra après la réinitialisation.`;

const savesTo = (agentId: string) =>
  records.filter((r) => r.input.kind === 'usage-save' && r.input.to === agentId);
const notices = (agentId: string) =>
  records.filter((r) => r.input.kind === 'usage-paused' && r.input.to === agentId);

beforeEach(async () => {
  clock = new TestClock();
  root = await mkdtemp(join(tmpdir(), 'pact-usage-limit-'));
  stores = openStores(root);
  calls = [];
  records = [];
  delivered = [];
  paused = [];
  pauses = [];
  members = { [key('claude-code', 'default')]: [A, B], [key('codex', 'default')]: [CODEX] };
  frozen = new Set();
  autoResumeOf = {};
  service = await create();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the save instruction (FR-003, FR-004; US1 sc.1)', () => {
  it('Given a threshold of 90 %, When a reading reaches 87 %, Then each agent of the account, in every workspace, gets one usage-save with the text of the contract, then an urgent wake', async () => {
    await service.onUsage(state([window5h(87), weekly(30)]));

    expect(records).toHaveLength(2);
    for (const target of [A, B]) {
      expect(records.find((r) => r.input.to === target.id)).toEqual({
        workspaceId: target.workspaceId,
        input: has({
          from: 'pact',
          to: target.id,
          kind: 'usage-save',
          text: saveText('5 h', 87, 90),
        }),
      });
    }
    expect(delivered).toEqual([
      { agentId: A.id, urgent: true },
      { agentId: B.id, urgent: true },
    ]);
    // The instruction is in the journal before the wake reads it.
    expect(calls.indexOf(`record:usage-save:${A.id}`)).toBeLessThan(
      calls.indexOf(`deliver:${A.id}`),
    );
    expect(calls.indexOf(`record:usage-save:${B.id}`)).toBeLessThan(
      calls.indexOf(`deliver:${B.id}`),
    );
    expect(pauses).toEqual([]);
  });

  it('Given a save sent, When a second reading says 88 %, Then nothing is sent again', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(88)]));
    expect(records).toHaveLength(2);
    expect(delivered).toHaveLength(2);
  });

  it('Given a save sent, When a reading goes back down and up again before the reset, Then the save is not sent again', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(84)]));
    await service.onUsage(state([window5h(88)]));
    expect(records).toHaveLength(2);
    expect(pauses).toEqual([]);
  });

  it('Given a save sent, When the window resets and a new reading reaches 87 %, Then a new save goes out', async () => {
    await service.onUsage(state([window5h(87)]));
    await clock.advance(2.5 * 3_600_000);
    await service.onUsage(state([window5h(87, { resetsAt: NEXT_RESET_5H })]));
    expect(savesTo(A.id)).toHaveLength(2);
    expect(savesTo(B.id)).toHaveLength(2);
  });

  it('Given a save sent, When PACT restarts, Then the new service does not send it again: it was saved with its reset', async () => {
    await service.onUsage(state([window5h(87)]));
    const { usageLimit } = await stores.state.read();
    expect(usageLimit.saves).toEqual([
      has({
        cliId: 'claude-code',
        account: 'default',
        windowId: 'five-hour',
        resetsAt: RESET_5H,
        agentIds: expect.arrayContaining([A.id, B.id]) as string[],
      }),
    ]);

    service = await create();
    await service.onUsage(state([window5h(88)]));
    expect(records).toHaveLength(2);
  });

  it('Given a threshold of 80 % on the week, When the week reads 78 %, Then the save names the week and its own threshold', async () => {
    const saved = await stores.state.read();
    await stores.state.write({ ...saved, usageStops: { 'claude-code': { week: 80 } } });
    await service.onUsage(state([window5h(50), weekly(78)]));
    expect(savesTo(A.id).map((r) => r.input.text)).toEqual([saveText('semaine', 78, 80)]);
  });

  it('Given an agent whose commit 008 froze, When the band is read, Then it gets no save, and the others do (US1 sc.9)', async () => {
    frozen.add(A.id);
    await service.onUsage(state([window5h(87)]));
    expect(savesTo(A.id)).toEqual([]);
    expect(delivered.map((d) => d.agentId)).toEqual([B.id]);
    expect(savesTo(B.id)).toHaveLength(1);
  });

  it('Given an agent in error, When the band is read, Then it gets no save; an agent awaiting an answer gets it (007 holds the pointer)', async () => {
    const failed = agent(4, {
      state: 'error',
      lastError: { code: null, kind: 'rate-limit', message: 'Limite' },
    });
    const asking = agent(5, { state: 'awaiting-answer' });
    members[key('claude-code', 'default')] = [failed, asking];
    await service.onUsage(state([window5h(87)]));
    expect(savesTo(failed.id)).toEqual([]);
    expect(savesTo(asking.id)).toHaveLength(1);
  });

  it('Given a Codex account and a Claude account, When Claude reads 87 %, Then the agent of Codex gets nothing (US1 sc.8)', async () => {
    await service.onUsage(state([window5h(87)]));
    expect(savesTo(CODEX.id)).toEqual([]);
    expect(delivered.map((d) => d.agentId)).not.toContain(CODEX.id);
  });
});

describe('the stop at the threshold (FR-005, SC-001; US1 sc.4, 5, 8, 10)', () => {
  it('Given a save sent, When a reading reaches 90 %, Then every agent of the account is paused within 5 s, once, with the window and the reset', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);

    expect(pauses.map((p) => p.agentId).sort()).toEqual([A.id, B.id].sort());
    for (const { pause } of pauses) {
      expect(pause).toEqual(
        has({
          cliId: 'claude-code',
          account: 'default',
          cause: 'threshold',
          windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: RESET_5H }],
          resumeAt: RESET_5H,
          pausedAt: expect.any(String) as string,
        }),
      );
    }
    // No second save: the one of 87 % stands for this reset.
    expect(records.filter((r) => r.input.kind === 'usage-save')).toHaveLength(2);
    // The agents of Codex go on.
    expect(pauses.map((p) => p.agentId)).not.toContain(CODEX.id);
  });

  it('Given an agent already paused, When another reading above the threshold comes, Then it is not paused twice', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await service.onUsage(state([window5h(91)]));
    await clock.advance(60_000);
    expect(pauses).toHaveLength(2);
  });

  it('Given the week at its threshold before the 5 h window, When it is read, Then the agents are paused and the pause names the week (US1 sc.5)', async () => {
    await service.onUsage(state([window5h(60), weekly(88)]));
    await service.onUsage(state([window5h(62), weekly(90)]));
    await clock.advance(5000);
    expect(pauses).toHaveLength(2);
    for (const { pause } of pauses) {
      expect(pause.windows).toEqual([
        { id: 'week', label: 'semaine', percent: 90, resetsAt: RESET_WEEK },
      ]);
      expect(pause.resumeAt).toBe(RESET_WEEK);
    }
    expect(notices(A.id).map((r) => r.input.text)).toEqual([
      `PACT t'a mis en pause : limite semaine à 90 %. Reprise prévue à ${clockTime(RESET_WEEK)}.`,
    ]);
  });

  it('Given no reading at all for a CLI, When any reading comes, Then its agents are never stopped (FR-011, US1 sc.10)', async () => {
    const quiet = agent(6, { cliId: 'plain' });
    members[key('plain', 'default')] = [quiet];
    await service.onUsage({
      cliId: 'plain',
      account: 'default',
      reading: null,
      shares: [],
      level: 'ok',
    });
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(95)]));
    await clock.advance(60_000);
    expect(pauses.map((p) => p.agentId)).not.toContain(quiet.id);
    expect(records.map((r) => r.input.to)).not.toContain(quiet.id);
    expect(service.usageHeld('plain')).toBe(false);
  });

  it('Given an agent in a rate limit error of the account, When the threshold is reached, Then it is paused too (R6)', async () => {
    const failed = agent(7, {
      state: 'error',
      lastError: { code: null, kind: 'rate-limit', message: 'Limite' },
    });
    members[key('claude-code', 'default')] = [A, failed];
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    expect(pauses.map((p) => p.agentId).sort()).toEqual([A.id, failed.id].sort());
  });

  it('Given a Codex account at the limit and a Claude account below, When Codex reads 91 %, Then only the agent of Codex is paused (US1 sc.8)', async () => {
    await service.onUsage(state([window5h(40)]));
    await service.onUsage(state([window5h(88)], { cliId: 'codex' }));
    await service.onUsage(state([window5h(91)], { cliId: 'codex' }));
    await clock.advance(5000);
    expect(pauses.map((p) => p.agentId)).toEqual([CODEX.id]);
    expect(pauses[0]?.pause).toEqual(has({ cliId: 'codex' }));
  });

  it('Given the agent frozen by 008, When the threshold is reached, Then it is stopped all the same: the manager marks it not saved (US1 sc.9)', async () => {
    frozen.add(A.id);
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    expect(pauses.map((p) => p.agentId).sort()).toEqual([A.id, B.id].sort());
  });
});

describe('a reading that jumps over the band (FR-005, Q8; US1 sc.7, O5)', () => {
  it('Given a reading from 85 to 92 %, When it comes, Then the save goes at once with « dans la minute »', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));
    expect(savesTo(A.id).map((r) => r.input.text)).toEqual([saveText('5 h', 92, 90, true)]);
    expect(delivered.filter((d) => d.urgent)).toHaveLength(2);
    expect(pauses).toEqual([]);
  });

  it('Given that jump, When an agent ends its turn, Then it is paused then; the other one at 60 s, not before', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));

    await clock.advance(10_000);
    expect(pauses).toEqual([]);
    await service.turnFinished(A.id);
    expect(pauses.map((p) => p.agentId)).toEqual([A.id]);

    await clock.advance(49_999);
    expect(pauses.map((p) => p.agentId)).toEqual([A.id]);
    await clock.advance(1);
    expect(pauses.map((p) => p.agentId)).toEqual([A.id, B.id]);
  });

  it('Given that jump, When 60 s pass with no end of turn, Then all the agents are paused, once', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));
    await clock.advance(60_000);
    expect(pauses.map((p) => p.agentId).sort()).toEqual([A.id, B.id].sort());
    await service.turnFinished(A.id);
    await clock.advance(60_000);
    expect(pauses).toHaveLength(2);
  });

  it('Given a deferred stop, When the window resets before the 60 s, Then nothing is paused at 60 s', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));
    await clock.advance(10_000);
    // The window reset since: its reset time is behind the clock, so it reads 0 %.
    await service.onUsage(state([window5h(92, { resetsAt: '2030-01-01T08:59:00.000Z' })]));
    await clock.advance(60_000);
    expect(pauses).toEqual([]);
  });

  it('Given a deferred stop, When the window resets and then an agent ends its turn, Then it is not paused', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));
    await clock.advance(10_000);
    await service.onUsage(state([window5h(92, { resetsAt: '2030-01-01T08:59:00.000Z' })]));
    await service.turnFinished(A.id);
    await clock.advance(60_000);
    expect(pauses).toEqual([]);
  });

  it('Given a first reading above the threshold, When it comes, Then it is a jump too: the save goes, the stop waits', async () => {
    await service.onUsage(state([window5h(93)]));
    expect(savesTo(A.id)).toHaveLength(1);
    expect(pauses).toEqual([]);
    await clock.advance(60_000);
    expect(pauses).toHaveLength(2);
  });
});

describe('the journal (FR-013; US1 sc.11)', () => {
  it('Given a stop, When the agents are paused, Then each gets a usage-paused with the window, the percentage and the resume time', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    for (const target of [A, B]) {
      expect(notices(target.id)).toEqual([
        {
          workspaceId: target.workspaceId,
          input: has({
            from: 'pact',
            to: target.id,
            kind: 'usage-paused',
            text: `PACT t'a mis en pause : limite 5 h à 90 %. Reprise prévue à ${clockTime(RESET_5H)}.`,
          }),
        },
      ]);
      // The notice follows the stop of the agent.
      expect(calls.indexOf(`pause:${target.id}`)).toBeLessThan(
        calls.indexOf(`record:usage-paused:${target.id}`),
      );
    }
  });

  it('Given two windows at the threshold, When the stop is written, Then the notice names both', async () => {
    await service.onUsage(state([window5h(88), weekly(88)]));
    await service.onUsage(state([window5h(91), weekly(90)]));
    await clock.advance(5000);
    expect(notices(A.id).map((r) => r.input.text)).toEqual([
      `PACT t'a mis en pause : limites 5 h à 91 % et semaine à 90 %. Reprise prévue à ${clockTime(RESET_WEEK)}.`,
    ]);
    expect(pauses[0]?.pause.resumeAt).toBe(RESET_WEEK);
  });

  it('Given a window without a known reset, When the stop is written, Then the notice says the time is unknown', async () => {
    await service.onUsage(state([window5h(88, { resetsAt: null })]));
    await service.onUsage(state([window5h(90, { resetsAt: null })]));
    await clock.advance(5000);
    expect(notices(A.id).map((r) => r.input.text)).toEqual([
      `PACT t'a mis en pause : limite 5 h à 90 %. Reprise après la réinitialisation, heure inconnue.`,
    ]);
    expect(pauses[0]?.pause.resumeAt).toBeNull();
  });

  it('Given a workspace where the automatic resume is off, When the stop is written, Then its notice says the user resumes by hand', async () => {
    autoResumeOf = { w1: true, w2: false };
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    expect(notices(A.id).map((r) => r.input.text)).toEqual([
      `PACT t'a mis en pause : limite 5 h à 90 %. Reprise prévue à ${clockTime(RESET_5H)}.`,
    ]);
    expect(notices(B.id).map((r) => r.input.text)).toEqual([
      `PACT t'a mis en pause : limite 5 h à 90 %. Reprise à la main par l'utilisateur.`,
    ]);
  });
});

describe('the cut of the wakes and the pause of an account (R12, R13)', () => {
  it('Given no reading at the threshold, When asked, Then the usage is not held, nor in the save band', async () => {
    expect(service.usageHeld('claude-code')).toBe(false);
    await service.onUsage(state([window5h(87)]));
    expect(service.usageHeld('claude-code')).toBe(false);
    expect(service.pausedFor('claude-code')).toBeNull();
  });

  it('Given a reading at the threshold, When the agents are not stopped yet, Then the usage is held for that CLI only', async () => {
    await service.onUsage(state([window5h(85)]));
    await service.onUsage(state([window5h(92)]));
    expect(pauses).toEqual([]);
    expect(service.usageHeld('claude-code')).toBe(true);
    expect(service.usageHeld('codex')).toBe(false);
  });

  it('Given the agents paused, When a reading below the threshold comes, Then the account is still in pause, with its window and reset', async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    expect(service.usageHeld('claude-code')).toBe(true);
    expect(service.pausedFor('claude-code')).toEqual(
      has({
        cliId: 'claude-code',
        account: 'default',
        windows: [has({ id: 'five-hour', label: '5 h' })] as unknown[],
        resumeAt: RESET_5H,
      }),
    );
    await service.onUsage(state([window5h(50)]));
    expect(service.usageHeld('claude-code')).toBe(true);
    expect(service.pausedFor('codex')).toBeNull();
  });
});

describe('an agent launched by the user during the pause (O1)', () => {
  const pauseTheAccount = async () => {
    await service.onUsage(state([window5h(87)]));
    await service.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    expect(pauses).toHaveLength(2);
  };

  it('Given a pause, When the user launches an agent of that CLI, Then it gets an override for itself alone, until the reset', async () => {
    await pauseTheAccount();
    const mine = agent(8, { launchedBy: null });
    await service.launched('w1', [mine]);
    const { usageLimit } = await stores.state.read();
    expect(usageLimit.overrides).toEqual([
      { cliId: 'claude-code', account: 'default', until: RESET_5H, agentId: mine.id },
    ]);
  });

  it('Given an agent launched by an orchestrator during the pause, When it starts, Then it gets no override', async () => {
    await pauseTheAccount();
    await service.launched('w1', [agent(9, { launchedBy: A.id })]);
    expect((await stores.state.read()).usageLimit.overrides).toEqual([]);
  });

  it('Given an override, When the readings stay above the threshold, Then that agent gets neither a save nor a stop', async () => {
    await pauseTheAccount();
    const mine = agent(8, { launchedBy: null });
    members[key('claude-code', 'default')] = [A, B, mine];
    await service.launched('w1', [mine]);

    await service.onUsage(state([window5h(91)]));
    await clock.advance(60_000);
    expect(pauses.map((p) => p.agentId)).not.toContain(mine.id);
    expect(savesTo(mine.id)).toEqual([]);
    expect(service.usageHeld('claude-code')).toBe(true);
  });

  it('Given an override, When the window resets and the next one reaches the threshold, Then that agent is paused like the others', async () => {
    await pauseTheAccount();
    const mine = agent(8, { launchedBy: null });
    members[key('claude-code', 'default')] = [A, B, mine];
    await service.launched('w1', [mine]);

    await clock.advance(2.5 * 3_600_000);
    await service.onUsage(state([window5h(87, { resetsAt: NEXT_RESET_5H })]));
    await service.onUsage(state([window5h(90, { resetsAt: NEXT_RESET_5H })]));
    await clock.advance(5000);
    expect(pauses.map((p) => p.agentId)).toContain(mine.id);
  });
});

// 009 T028 — US2: the resume at the reset (research R8 to R10; contracts/events.md « usage-resumed »; spec US2
// sc.2, 5, 6, 8, 10, FR-008, FR-012, FR-013). Same service, same clock, more fake dependencies.
//
// API fixed here for the dev, on top of the one above (see the report, « API fixées »):
//   options.agents.pausedAgents(cliId, account): Agent[]         the agents in `paused` of the account, in every
//                                                                workspace, each with its `pause` (T032)
//   options.agents.resumePaused(agentId): Promise<'resumed' | 'blocked'>
//                                                                AgentManager.resumePaused (T032): `startAgain` with
//                                                                the sessionId and `pause` back to null; 'blocked'
//                                                                when the sessionId is null (pause.blocked: 'session')
//   options.agents.schedule(agentId, resume): Promise<void>      sets (or, with null, clears) `scheduledResume`
//   options.git.indexLock(worktreePath): Promise<string | null>  GitService.indexLock (T034): the path, never erased
//   options.cliName(cliId): string                               « Claude » for `claude-code`: names in the notices
//   service.resumeAccount(cliId, account): Promise<void>         the resume at its time (R8): reads the last reading
//                                                                again, waits for a window still at its threshold,
//                                                                else resumes the account, orchestrators first
//   service.resumeByHand(cliId, account): Promise<void>         « Reprendre » of À faire (R10): resumes the account as
//                                                                at the reset and writes an override of the account
//   service.resumeAgent(agentId): Promise<void>                 « Reprendre » of the tile (R10): that agent alone,
//                                                                with an override of its own
//   service.cancelResume(cliId, account): Promise<void>        « Annuler la reprise »: `schedule(id, null)` for each
//                                                                paused agent of the account, which stay paused
// The notice is `exchanges.record(workspaceId, { from: 'pact', to, kind: 'usage-resumed', type, text })`; an
// `action` is followed by `wake.deliver(agentId)` (not urgent), an `info` by nothing.

type Scheduled = { agentId: string; at: string; attempt: number } | null;
type ResumeService = ServiceLike & {
  resumeAccount(cliId: string, account: string): Promise<void>;
  resumeByHand(cliId: string, account: string): Promise<void>;
  resumeAgent(agentId: string): Promise<void>;
  cancelResume(cliId: string, account: string): Promise<void>;
};
type ResumeOptions = ServiceOptions & {
  agents: ServiceOptions['agents'] & {
    pausedAgents(cliId: string, account: string): Agent[];
    resumePaused(agentId: string): Promise<'resumed' | 'blocked'>;
    schedule(agentId: string, resume: Scheduled): Promise<void>;
  };
  git: { indexLock(worktreePath: string): Promise<string | null> };
  cliName(cliId: string): string;
};

describe('the resume at the reset (US2; R8 to R10)', () => {
  let waiting: Agent[];
  let resumeCalls: string[];
  let schedules: { agentId: string; resume: Scheduled }[];
  let locks: Record<string, string>;
  let blockedIds: Set<string>;
  let resuming: ResumeService;

  const ORCHESTRATOR = agent(10, { role: 'orchestrator', name: 'Claude 1', state: 'working' });
  const WORKER = agent(11, {
    role: 'dev',
    name: 'Claude 2',
    state: 'working',
    worktreePath: '/wt/2',
  });
  const IDLE = agent(12, {
    role: 'test',
    name: 'Claude 3',
    state: 'awaiting-prompt',
    worktreePath: '/wt/3',
  });

  const paused = (source: Agent, over: Record<string, unknown> = {}): Agent => {
    const pause = pauses.find((p) => p.agentId === source.id)?.pause;
    return {
      ...source,
      state: 'paused',
      sessionId: source.sessionId ?? `session-${source.id.slice(-2)}`,
      pause: {
        ...pause,
        midTurn: source.state === 'working',
        saved: true,
        closedQuestion: null,
        blocked: null,
        ...over,
      },
    } as Agent;
  };

  const createResuming = async () => {
    const { UsageLimitService } = await load();
    const options: ResumeOptions = {
      agents: {
        accountAgents: (cliId, account) =>
          (members[key(cliId, account)] ?? []).filter((a) => !paused_.has(a.id)),
        pause: (agentId, pause) => {
          calls.push(`pause:${agentId}`);
          pauses.push({ agentId, pause });
          paused_.add(agentId);
          return Promise.resolve();
        },
        pausedAgents: (cliId, account) =>
          waiting.filter((a) => a.pause?.cliId === cliId && a.pause.account === account),
        resumePaused: (agentId) => {
          resumeCalls.push(agentId);
          calls.push(`resume:${agentId}`);
          if (blockedIds.has(agentId)) return Promise.resolve('blocked' as const);
          waiting = waiting.filter((a) => a.id !== agentId);
          paused_.delete(agentId);
          return Promise.resolve('resumed' as const);
        },
        schedule: (agentId, resume) => {
          schedules.push({ agentId, resume });
          return Promise.resolve();
        },
      },
      exchanges: {
        record: (workspaceId, input) => {
          calls.push(`record:${String(input.kind)}:${String(input.to)}`);
          records.push({ workspaceId, input });
          return Promise.resolve({});
        },
      },
      wake: {
        deliver: (agentId, options) => {
          calls.push(`deliver:${agentId}`);
          delivered.push({ agentId, urgent: options?.urgent === true });
        },
      },
      git: { indexLock: (path) => Promise.resolve(locks[path] ?? null) },
      cliName: () => 'Claude',
      stores,
      clock,
      autoResume: (workspaceId) => Promise.resolve(autoResumeOf[workspaceId] ?? true),
      commitFrozen: () => false,
    };
    return new UsageLimitService(options) as ResumeService;
  };
  /** The ids the fake manager has stopped: they are no longer listed by `accountAgents`. */
  let paused_: Set<string>;

  /** Stops the account (87 %, then 90 %), then lists its agents as paused, as the manager would. */
  const pauseTheAccount = async (windows: UsageWindow[] = [window5h(90)]) => {
    await resuming.onUsage(state(windows.map((w) => ({ ...w, usedPercent: 87 }))));
    await resuming.onUsage(state(windows));
    await clock.advance(5000);
    waiting = (members[key('claude-code', 'default')] ?? []).map((a) => paused(a));
  };
  const resumed = (agentId: string) =>
    records.filter((r) => r.input.kind === 'usage-resumed' && r.input.to === agentId);
  const sentTo = (agentId: string) => resumed(agentId).map((r) => r.input.text as string);
  const headline = (percent = 90, label = '5 h') =>
    `Reprise après la limite ${label} (${String(percent)} %), en pause de ${clockTime(START)} à ${clockTime(RESET_5H)}.`;

  beforeEach(async () => {
    waiting = [];
    resumeCalls = [];
    schedules = [];
    locks = {};
    blockedIds = new Set();
    paused_ = new Set();
    members = { [key('claude-code', 'default')]: [ORCHESTRATOR, WORKER, IDLE] };
    resuming = await createResuming();
  });

  describe('when it is due (US2 sc.1, 2, 7)', () => {
    it('Given the 5 h window reset, When the resume is due, Then every paused agent is resumed, the orchestrator first, and the account is no longer in pause', async () => {
      await pauseTheAccount();
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(resumeCalls[0]).toBe(ORCHESTRATOR.id);
      expect([...resumeCalls].sort()).toEqual([ORCHESTRATOR.id, WORKER.id, IDLE.id].sort());
      expect(resuming.pausedFor('claude-code')).toBeNull();
      expect(resuming.usageHeld('claude-code')).toBe(false);
    });

    it('Given a pause on the 5 h window and the week read at its threshold since, When the 5 h resume is due, Then nobody is resumed and each agent waits for the reset of the week (US2 sc.2)', async () => {
      await pauseTheAccount();
      await resuming.onUsage(state([window5h(90), weekly(91)]));
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(resumeCalls).toEqual([]);
      expect(schedules.map((s) => s.agentId).sort()).toEqual(
        [ORCHESTRATOR.id, WORKER.id, IDLE.id].sort(),
      );
      for (const { resume } of schedules) expect(resume).toEqual(has({ at: RESET_WEEK }));
      expect(resuming.pausedFor('claude-code')).not.toBeNull();
    });

    it('Given that wait, When the week resets, Then the resume goes through', async () => {
      await pauseTheAccount();
      await resuming.onUsage(state([window5h(90), weekly(91)]));
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');
      await clock.advance(4 * 24 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');
      expect([...resumeCalls].sort()).toEqual([ORCHESTRATOR.id, WORKER.id, IDLE.id].sort());
    });

    it('Given the automatic resume off in one workspace, When a second window makes the resume wait, Then the agents of that workspace get no scheduled resume (US2 sc.6)', async () => {
      autoResumeOf = { w1: true, w2: false };
      const other = agent(13, { workspaceId: 'w2', state: 'awaiting-prompt', name: 'Claude 4' });
      members[key('claude-code', 'default')] = [ORCHESTRATOR, other];
      await pauseTheAccount();
      await resuming.onUsage(state([window5h(90), weekly(91)]));
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(schedules.filter((s) => s.agentId === ORCHESTRATOR.id)).toHaveLength(1);
      expect(schedules.filter((s) => s.agentId === other.id && s.resume !== null)).toEqual([]);
    });

    it('Given no known reset, When the resume is due, Then the account is resumed although the last reading is still above the threshold (O2)', async () => {
      members[key('claude-code', 'default')] = [WORKER, IDLE];
      await pauseTheAccount([window5h(90, { resetsAt: null })]);
      await clock.advance(60_000);
      await resuming.resumeAccount('claude-code', 'default');
      expect([...resumeCalls].sort()).toEqual([WORKER.id, IDLE.id].sort());
      const { usageLimit } = await stores.state.read();
      expect(usageLimit.resumed).toEqual([
        { cliId: 'claude-code', account: 'default', at: clock.now().toISOString() },
      ]);
    });

    it('Given a resume with no known reset, When the same old reading comes again, Then nobody is stopped again; a reading taken after the resume stops them (O2)', async () => {
      members[key('claude-code', 'default')] = [WORKER, IDLE];
      const old = state([window5h(90, { resetsAt: null })]);
      await pauseTheAccount([window5h(90, { resetsAt: null })]);
      await clock.advance(60_000);
      await resuming.resumeAccount('claude-code', 'default');
      const before = pauses.length;

      await resuming.onUsage(old);
      await clock.advance(60_000);
      expect(pauses).toHaveLength(before);

      await clock.advance(1000);
      await resuming.onUsage(state([window5h(91, { resetsAt: null })]));
      await clock.advance(60_000);
      expect(pauses.length).toBeGreaterThan(before);
    });

    it('Given an agent whose session is unknown, When the resume is due, Then it stays paused, is not told it resumed, and the others go on (US2 sc.5)', async () => {
      await pauseTheAccount();
      blockedIds.add(IDLE.id);
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');
      expect(resumeCalls).toContain(IDLE.id);
      expect(resumed(IDLE.id)).toEqual([]);
      expect(resumed(WORKER.id)).toHaveLength(1);
    });
  });

  describe('the notice usage-resumed (FR-008, FR-012, FR-013; US2 sc.3, 10)', () => {
    it('Given an agent that was mid-turn, When it resumes, Then it gets an action with the continue sentence, and a wake once it is ready', async () => {
      await pauseTheAccount();
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(resumed(WORKER.id)).toEqual([
        {
          workspaceId: 'w1',
          input: has({
            from: 'pact',
            to: WORKER.id,
            kind: 'usage-resumed',
            type: 'action',
            text: `${headline()} Reprends ton travail là où tu t'es arrêté.`,
          }),
        },
      ]);
      expect(delivered).toContainEqual({ agentId: WORKER.id, urgent: false });
      // The agent is started again before it is told, and the notice is in the journal before the wake.
      expect(calls.indexOf(`resume:${WORKER.id}`)).toBeLessThan(
        calls.indexOf(`record:usage-resumed:${WORKER.id}`),
      );
      expect(calls.indexOf(`record:usage-resumed:${WORKER.id}`)).toBeLessThan(
        calls.lastIndexOf(`deliver:${WORKER.id}`),
      );
    });

    it('Given an agent that was idle, When it resumes, Then it gets an info with the first sentence only, and no wake', async () => {
      await pauseTheAccount();
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(resumed(IDLE.id)).toEqual([
        {
          workspaceId: 'w1',
          input: has({ to: IDLE.id, kind: 'usage-resumed', type: 'info', text: headline() }),
        },
      ]);
      expect(delivered.filter((d) => !d.urgent).map((d) => d.agentId)).not.toContain(IDLE.id);
    });

    it('Given an orchestrator, When the account resumes, Then it gets an action naming the agents resumed and saying the pause counted no turn', async () => {
      members[key('claude-code', 'default')] = [ORCHESTRATOR, WORKER];
      await pauseTheAccount();
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');

      expect(resumed(ORCHESTRATOR.id)).toEqual([
        {
          workspaceId: 'w1',
          input: has({
            to: ORCHESTRATOR.id,
            kind: 'usage-resumed',
            type: 'action',
            text: `${headline()} Agents repris : Claude 2 · dev. La pause n'a compté aucun tour ni rapport manquant.`,
          }),
        },
      ]);
      expect(delivered).toContainEqual({ agentId: ORCHESTRATOR.id, urgent: false });
    });

    it('Given an agent not saved at the stop, When the account resumes, Then the orchestrator is told which one', async () => {
      members[key('claude-code', 'default')] = [ORCHESTRATOR, WORKER];
      await pauseTheAccount();
      waiting = waiting.map((a) => (a.id === WORKER.id ? paused(WORKER, { saved: false }) : a));
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');
      expect(sentTo(ORCHESTRATOR.id)[0]).toContain(" Non sauvegardé à l'arrêt : Claude 2 · dev.");
    });

    it('Given a Git lock in a worktree, When the account resumes, Then the agent is told, the lock is named and PACT erases nothing', async () => {
      await pauseTheAccount();
      locks['/wt/2'] = '/wt/2/.git/index.lock';
      await clock.advance(2 * 3_600_000);
      await resuming.resumeAccount('claude-code', 'default');
      expect(sentTo(WORKER.id)[0]).toContain(
        " Verrou Git trouvé dans /wt/2 : vérifie-le avant de committer, PACT ne l'a pas effacé.",
      );
      expect(sentTo(IDLE.id)[0]).not.toContain('Verrou Git');
      // The agent resumed all the same: the lock is reported, not a reason to wait.
      expect(resumeCalls).toContain(WORKER.id);
    });
  });

  describe('« Reprendre » and « Annuler la reprise » (US2 sc.6, 8; R10)', () => {
    it('Given a pause, When the user resumes the account from À faire, Then every agent resumes, orchestrator first, and an override covers the account until the reset', async () => {
      await pauseTheAccount();
      await resuming.resumeByHand('claude-code', 'default');

      expect(resumeCalls[0]).toBe(ORCHESTRATOR.id);
      expect([...resumeCalls].sort()).toEqual([ORCHESTRATOR.id, WORKER.id, IDLE.id].sort());
      expect((await stores.state.read()).usageLimit.overrides).toEqual([
        { cliId: 'claude-code', account: 'default', until: RESET_5H, agentId: null },
      ]);
      expect(resuming.pausedFor('claude-code')).toBeNull();
    });

    it('Given the account resumed by hand, When readings stay above the threshold, Then no agent gets a save or is stopped again until the reset (US2 sc.8)', async () => {
      await pauseTheAccount();
      await resuming.resumeByHand('claude-code', 'default');
      const stops = pauses.length;
      const saves = records.filter((r) => r.input.kind === 'usage-save').length;

      await resuming.onUsage(state([window5h(92)]));
      await clock.advance(60_000);
      expect(pauses).toHaveLength(stops);
      expect(records.filter((r) => r.input.kind === 'usage-save')).toHaveLength(saves);
      expect(resuming.usageHeld('claude-code')).toBe(false);
    });

    it('Given the override of the account, When the window resets and the next one reaches the threshold, Then the agents are stopped again', async () => {
      await pauseTheAccount();
      await resuming.resumeByHand('claude-code', 'default');
      await clock.advance(2.5 * 3_600_000);
      await resuming.onUsage(state([window5h(87, { resetsAt: NEXT_RESET_5H })]));
      await resuming.onUsage(state([window5h(90, { resetsAt: NEXT_RESET_5H })]));
      await clock.advance(5000);
      expect(pauses.length).toBeGreaterThan(3);
    });

    it('Given a pause, When the user resumes one agent from its tile, Then that agent alone resumes, with an override of its own, and the account stays in pause', async () => {
      await pauseTheAccount();
      await resuming.resumeAgent(WORKER.id);

      expect(resumeCalls).toEqual([WORKER.id]);
      expect((await stores.state.read()).usageLimit.overrides).toEqual([
        { cliId: 'claude-code', account: 'default', until: RESET_5H, agentId: WORKER.id },
      ]);
      expect(resuming.pausedFor('claude-code')).not.toBeNull();
    });

    it('Given one agent resumed from its tile, When readings stay above the threshold, Then that agent is not stopped again, and the others stay paused', async () => {
      await pauseTheAccount();
      await resuming.resumeAgent(WORKER.id);
      const stops = pauses.length;
      members[key('claude-code', 'default')] = [WORKER];

      await resuming.onUsage(state([window5h(92)]));
      await clock.advance(60_000);
      expect(pauses).toHaveLength(stops);
      expect(waiting.map((a) => a.id).sort()).toEqual([ORCHESTRATOR.id, IDLE.id].sort());
    });

    it('Given scheduled resumes, When the user cancels the resume, Then each paused agent loses its scheduled resume and nobody resumes', async () => {
      await pauseTheAccount();
      await resuming.cancelResume('claude-code', 'default');

      expect(
        schedules
          .filter((s) => s.resume === null)
          .map((s) => s.agentId)
          .sort(),
      ).toEqual([ORCHESTRATOR.id, WORKER.id, IDLE.id].sort());
      expect(schedules.filter((s) => s.resume !== null)).toEqual([]);
      expect(resumeCalls).toEqual([]);
      expect(resuming.pausedFor('claude-code')).not.toBeNull();
    });
  });
});

// 009 T037 — US3: a reading too old (research R11; spec US3 sc.1 to 4, SC-006). The service checks every minute
// (`STALE_CHECK_MS`), only once it holds a reading, and offers to stop by caution; it never stops on its own.
//
// API fixed here for the dev (see the report, « API fixées »), `src/main/usage/usage-limit-service.ts`:
//   options.onStale(offers: StaleOffer[]): void       called with the whole list of the offers each time it changes
//                                                      (renderer: `usage:stale-offers`-like push, free to the dev);
//                                                      `StaleOffer = { cliId, account, step, windows }` as
//                                                      `staleProposal` rates it (`windows`: id, label, percent, resetsAt)
//   service.decideStale(cliId, account, decision: 'stop' | 'later'): Promise<void>
//     'later': the offer goes, its step is kept in `state.usageLimit.declined` with the `readAt` it was made on
//     'stop' : like a jump over the band: usage-save « dans la minute » to the agents, then the stop at the end of
//              the turn or 60 s at most, `pause.cause: 'stale'`, notice « par prudence » (events.md)
// The agents counted as active are those `accountAgents` lists in `working`. Readings come from `onUsage`; a reading
// is `age` minutes old when the clock has advanced that much since it was made.
describe('a reading too old (US3; R11)', () => {
  type StaleOffer = {
    cliId: string;
    account: string;
    step: number;
    windows: { id: string; label: string; percent: number; resetsAt: string | null }[];
  };
  type StaleService = ServiceLike & {
    dispose(): void;
    agentChanged(): void;
    decideStale(cliId: string, account: string, decision: 'stop' | 'later'): Promise<void>;
  };

  const MIN = 60_000;
  let offers: StaleOffer[];
  let offerCalls: number;
  let timeouts: number[];
  let stale: StaleService;

  /** The same clock, which also tells the waits that were asked for. */
  const watched = (): Clock => ({
    now: () => clock.now(),
    setTimeout: (run, ms) => {
      timeouts.push(ms);
      return clock.setTimeout(run, ms);
    },
    clearTimeout: (timer) => {
      clock.clearTimeout(timer);
    },
  });

  const createStale = async () => {
    const { UsageLimitService } = await load();
    const options = {
      agents: {
        accountAgents: (cliId: string, account: string) =>
          (members[key(cliId, account)] ?? []).filter((a) => !paused.includes(a.id)),
        pause: (agentId: string, pause: Pause) => {
          calls.push(`pause:${agentId}`);
          pauses.push({ agentId, pause });
          paused.push(agentId);
          return Promise.resolve();
        },
        pausedAgents: () => [],
        resumePaused: () => Promise.resolve('resumed' as const),
        schedule: () => Promise.resolve(),
      },
      git: { indexLock: () => Promise.resolve(null) },
      cliName: () => 'Claude',
      exchanges: {
        record: (workspaceId: string, input: Record<string, unknown>) => {
          calls.push(`record:${String(input.kind)}:${String(input.to)}`);
          records.push({ workspaceId, input });
          return Promise.resolve({});
        },
      },
      wake: {
        deliver: (agentId: string, options?: { urgent?: boolean }) => {
          calls.push(`deliver:${agentId}`);
          delivered.push({ agentId, urgent: options?.urgent === true });
        },
      },
      stores,
      clock: watched(),
      autoResume: (workspaceId: string) => Promise.resolve(autoResumeOf[workspaceId] ?? true),
      commitFrozen: () => false,
      onStale: (next: StaleOffer[]) => {
        offerCalls++;
        offers = next;
      },
    };
    return new UsageLimitService(options) as StaleService;
  };

  /** Reads the account at `percent` of its 5 h window; the reading is dated now. */
  const read = (percent = 82) => stale.onUsage(state([window5h(percent)]));
  const decide = async (decision: 'stop' | 'later') => {
    await stale.decideStale('claude-code', 'default', decision);
    await flush();
  };
  const declined = async () => (await stores.state.read()).usageLimit.declined;

  beforeEach(async () => {
    offers = [];
    offerCalls = 0;
    timeouts = [];
    members = { [key('claude-code', 'default')]: [A, B] };
    stale = await createStale();
  });

  describe('the check every minute', () => {
    it('Given no reading at all, When time goes by, Then nothing is armed and nothing is offered', async () => {
      await clock.advance(2 * 3_600_000);
      expect(timeouts).toEqual([]);
      expect(offerCalls).toBe(0);
    });

    it('Given a reading, When it is taken, Then a check is armed every 60 s', async () => {
      await read();
      expect(timeouts).toContain(MIN);
      const armed = timeouts.length;
      await clock.advance(3 * MIN);
      // The check goes on by itself: it re-arms after each minute.
      expect(timeouts.length).toBeGreaterThanOrEqual(armed + 3);
      expect(new Set(timeouts)).toEqual(new Set([MIN]));
    });

    it('Given no agent at work, When minutes go by, Then the check stops by itself and an agent that starts working arms it again', async () => {
      members[key('claude-code', 'default')] = [B];
      await read(85);
      await clock.advance(5 * MIN);
      expect(timeouts).toEqual([MIN]);
      members[key('claude-code', 'default')] = [A, B];
      stale.agentChanged();
      await clock.advance(16 * MIN);
      expect(offers).toEqual([has({ cliId: 'claude-code', step: 1 })]);
    });

    it('Given the service is disposed, When time goes by, Then the check no longer runs', async () => {
      await read(85);
      stale.dispose();
      const armed = timeouts.length;
      await clock.advance(20 * MIN);
      expect(timeouts).toHaveLength(armed);
      expect(offers).toEqual([]);
    });

    it('Given a reading 14 and 15 minutes old, When the checks run, Then nothing is offered; at 16 minutes, one offer at step 1 (US3 sc.1)', async () => {
      await read(82);
      await clock.advance(15 * MIN);
      expect(offers).toEqual([]);
      await clock.advance(MIN);
      expect(offers).toEqual([
        {
          cliId: 'claude-code',
          account: 'default',
          step: 1,
          windows: [has({ id: 'five-hour', label: '5 h', percent: 82, resetsAt: RESET_5H })],
        },
      ]);
    });

    it('Given a reading far from the threshold, When it gets old, Then nothing is offered', async () => {
      await read(79);
      await clock.advance(40 * MIN);
      expect(offers).toEqual([]);
    });

    it('Given an old reading and no agent at work, When the checks run, Then nothing is offered (US3 sc.4)', async () => {
      members[key('claude-code', 'default')] = [B];
      await read(85);
      await clock.advance(40 * MIN);
      expect(offers).toEqual([]);
    });

    it('Given a Codex agent at work and no reading for Codex, When the checks run, Then only the Claude account is offered (FR-011)', async () => {
      members[key('codex', 'default')] = [CODEX];
      await read(85);
      await clock.advance(40 * MIN);
      expect(offers.map((o) => o.cliId)).toEqual(['claude-code']);
    });

    it('Given an offer, When a fresh reading far from the threshold comes, Then the offer is withdrawn', async () => {
      await read(85);
      await clock.advance(16 * MIN);
      expect(offers).toHaveLength(1);
      await read(40);
      expect(offers).toEqual([]);
    });
  });

  describe('never alone (SC-006)', () => {
    it('Given an offer nobody answers, When hours go by, Then no agent is told to save, woken or paused', async () => {
      // The reset is far (the week): a window reset meanwhile would be read at 0 % (R11).
      await stale.onUsage(state([window5h(84, { resetsAt: RESET_WEEK })]));
      await clock.advance(6 * 3_600_000);
      expect(offers).toHaveLength(1);
      expect(offers[0]?.step).toBeGreaterThanOrEqual(1);
      expect(pauses).toEqual([]);
      expect(delivered).toEqual([]);
      expect(records).toEqual([]);
    });

    it('Given an old reading at 82 %, When the checks run, Then no usage-save goes out: the offer is not an order', async () => {
      await read(82);
      await clock.advance(2 * 3_600_000);
      expect(records.filter((r) => r.input.kind === 'usage-save')).toEqual([]);
      expect(pauses).toEqual([]);
    });
  });

  describe('« Pas maintenant » (US3 sc.2)', () => {
    it('Given an offer, When the user declines, Then nothing is stopped, the offer goes, and its step is kept with the reading', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('later');
      expect(offers).toEqual([]);
      expect(pauses).toEqual([]);
      expect(records.filter((r) => r.input.kind === 'usage-save')).toEqual([]);
      expect(await declined()).toEqual([
        has({ cliId: 'claude-code', account: 'default', step: 1, readAt: START }),
      ]);
    });

    it('Given a declined offer, When 14 more minutes pass, Then nothing comes back; at the next 15-minute step (30 min) it comes back at step 2', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('later');
      await clock.advance(13 * MIN);
      expect(offers).toEqual([]);
      await clock.advance(MIN);
      expect(offers).toEqual([has({ cliId: 'claude-code', account: 'default', step: 2 })]);
      expect(pauses).toEqual([]);
    });

    it('Given the two steps declined, When the 45th minute comes, Then the third step is offered', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('later');
      await clock.advance(14 * MIN);
      await decide('later');
      expect(await declined()).toEqual([has({ step: 2 })]);
      await clock.advance(15 * MIN);
      expect(offers).toEqual([has({ step: 3 })]);
    });

    it('Given a declined offer, When PACT restarts, Then the new service does not offer the same step again', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('later');
      stale.dispose();
      offers = [];
      stale = await createStale();
      await stale.onUsage({
        ...state([window5h(82)]),
        reading: {
          cliId: 'claude-code',
          account: 'default',
          windows: [window5h(82)],
          readAt: START,
        },
      });
      await clock.advance(MIN);
      expect(offers).toEqual([]);
    });

    it('Given a declined offer, When a fresh reading comes, Then the refusal is erased and the offer comes back after 16 minutes', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('later');
      await read(83);
      expect(await declined()).toEqual([]);
      await clock.advance(15 * MIN);
      expect(offers).toEqual([]);
      await clock.advance(MIN);
      expect(offers).toEqual([has({ step: 1, windows: [has({ percent: 83 })] })]);
    });
  });

  describe('an answer with nothing to answer', () => {
    it('Given no reading, When the user answers, Then nothing happens', async () => {
      await decide('stop');
      await decide('later');
      expect(pauses).toEqual([]);
      expect(records).toEqual([]);
      expect(await declined()).toEqual([]);
    });

    it('Given a reading far from the threshold, When a late answer comes, Then nothing is kept or sent', async () => {
      await read(40);
      await clock.advance(20 * MIN);
      await decide('stop');
      await decide('later');
      expect(pauses).toEqual([]);
      expect(records).toEqual([]);
      expect(await declined()).toEqual([]);
    });

    it('Given an accepted stop, When the window resets before the stop, Then nobody is paused', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('stop');
      // A reading whose window resets within the minute: the stop has nothing left to wait for.
      await stale.onUsage(
        state([window5h(82, { resetsAt: new Date(clock.now().getTime() + 30_000).toISOString() })]),
      );
      await clock.advance(60_000);
      expect(pauses).toEqual([]);
    });

    it('Given an accepted stop, When the window resets before an end of turn, Then that end of turn pauses nobody', async () => {
      await read(82);
      await clock.advance(16 * MIN);
      await decide('stop');
      await stale.onUsage(
        state([window5h(82, { resetsAt: new Date(clock.now().getTime() + 5_000).toISOString() })]),
      );
      await clock.advance(10_000);
      await stale.turnFinished(A.id);
      expect(pauses).toEqual([]);
    });
  });

  describe('« Arrêter par prudence » (US3 sc.3)', () => {
    beforeEach(async () => {
      await read(82);
      await clock.advance(16 * MIN);
    });

    it('Given an offer, When the user accepts, Then each agent of the account gets the save instruction « dans la minute » and an urgent wake, and nobody is paused yet', async () => {
      await decide('stop');
      for (const target of [A, B]) {
        expect(savesTo(target.id).map((r) => r.input.text)).toEqual([
          saveText('5 h', 82, 90, true),
        ]);
        expect(calls.indexOf(`record:usage-save:${target.id}`)).toBeLessThan(
          calls.indexOf(`deliver:${target.id}`),
        );
      }
      expect(delivered.filter((d) => d.urgent)).toHaveLength(2);
      expect(pauses).toEqual([]);
      expect(offers).toEqual([]);
    });

    it('Given an acceptance, When an agent ends its turn, Then it is paused then, and the other one at 60 s, not before', async () => {
      await decide('stop');
      await clock.advance(10_000);
      expect(pauses).toEqual([]);
      await stale.turnFinished(A.id);
      expect(pauses.map((p) => p.agentId)).toEqual([A.id]);
      await clock.advance(49_999);
      expect(pauses.map((p) => p.agentId)).toEqual([A.id]);
      await clock.advance(1);
      expect(pauses.map((p) => p.agentId)).toEqual([A.id, B.id]);
    });

    it('Given an acceptance, When 60 s pass with no end of turn, Then every agent is paused once, with cause stale, the window near its threshold and its reset', async () => {
      await decide('stop');
      await clock.advance(60_000);
      expect(pauses.map((p) => p.agentId).sort()).toEqual([A.id, B.id].sort());
      for (const { pause } of pauses) {
        expect(pause).toEqual(
          has({
            cliId: 'claude-code',
            account: 'default',
            cause: 'stale',
            windows: [{ id: 'five-hour', label: '5 h', percent: 82, resetsAt: RESET_5H }],
            resumeAt: RESET_5H,
          }),
        );
      }
      await clock.advance(5 * MIN);
      expect(pauses).toHaveLength(2);
      expect(offers).toEqual([]);
    });

    it('Given an acceptance, When the agents are paused, Then each notice says « par prudence » with the last reading and its age', async () => {
      await decide('stop');
      await clock.advance(60_000);
      for (const target of [A, B]) {
        expect(notices(target.id).map((r) => r.input.text)).toEqual([
          expect.stringMatching(
            /^PACT t'a mis en pause par prudence : dernière lecture de la limite 5 h à 82 %, il y a 1[67] min\.$/,
          ),
        ]);
      }
    });

    it('Given an acceptance, When the paused account is read again below the threshold, Then it stays in pause until its reset', async () => {
      await decide('stop');
      await clock.advance(60_000);
      expect(stale.pausedFor('claude-code')).toMatchObject({ cause: 'stale' });
      expect(stale.usageHeld('claude-code')).toBe(true);
    });
  });
});

// 009 T044 — US4: a threshold changed applies at once (research R6 « Seuil changé »; spec US4 sc.2, 3; FR-001).
// The describe has its own setup: it only relies on the clock, the stores and the recorders above.
//
// API fixed here for the dev (see the report, « API fixées »):
//   service.setStops(stops: UsageStops): Promise<void>   the new thresholds, already written to `state.json` by the IPC
//                                                        handler (`settings:usageStops`); the service re-judges the last
//                                                        reading of every account with them. Lowered under the
//                                                        consumption = a jump over the band (save « dans la minute »,
//                                                        stop at the end of the turn or at 60 s); raised above every
//                                                        window of a paused account = `resumeAccount`.
// The test writes the stops to the store as the handler does, then calls `setStops`.

describe('a threshold changed applies at once (US4)', () => {
  type Stops = Record<string, Record<string, number>>;
  type StopsService = ServiceLike & { setStops(stops: Stops): Promise<void> };

  let waiting: Agent[];
  let resumeCalls: string[];
  let thresholds: StopsService;
  const OWNER = agent(20, { name: 'Claude 1', state: 'working', worktreePath: '/wt/20' });
  const OTHER = agent(21, {
    workspaceId: 'w2',
    name: 'Claude 2',
    state: 'awaiting-prompt',
    worktreePath: '/wt/21',
  });
  const stopped = new Set<string>();

  const build = async () => {
    const { UsageLimitService } = await load();
    const options: ResumeOptions = {
      agents: {
        accountAgents: (cliId, account) =>
          (members[key(cliId, account)] ?? []).filter((a) => !stopped.has(a.id)),
        pause: (agentId, pause) => {
          calls.push(`pause:${agentId}`);
          pauses.push({ agentId, pause });
          stopped.add(agentId);
          return Promise.resolve();
        },
        pausedAgents: (cliId, account) =>
          waiting.filter((a) => a.pause?.cliId === cliId && a.pause.account === account),
        resumePaused: (agentId) => {
          resumeCalls.push(agentId);
          waiting = waiting.filter((a) => a.id !== agentId);
          stopped.delete(agentId);
          return Promise.resolve('resumed' as const);
        },
        schedule: () => Promise.resolve(),
      },
      exchanges: {
        record: (workspaceId, input) => {
          calls.push(`record:${String(input.kind)}:${String(input.to)}`);
          records.push({ workspaceId, input });
          return Promise.resolve({});
        },
      },
      wake: {
        deliver: (agentId, deliverOptions) => {
          delivered.push({ agentId, urgent: deliverOptions?.urgent === true });
        },
      },
      git: { indexLock: () => Promise.resolve(null) },
      cliName: () => 'Claude',
      stores,
      clock,
      autoResume: () => Promise.resolve(true),
      commitFrozen: () => false,
    };
    return new UsageLimitService(options) as StopsService;
  };

  /** What the handler `settings:usageStops` does, then the call the service must serve. */
  const change = async (stops: Stops) => {
    const saved = await stores.state.read();
    await stores.state.write({ ...saved, usageStops: stops });
    await thresholds.setStops(stops);
  };

  /** Lists the agents as the manager would after the stop: paused, with their pause. */
  const listPaused = () => {
    waiting = (members[key('claude-code', 'default')] ?? []).map(
      (a) =>
        ({
          ...a,
          state: 'paused',
          sessionId: `session-${a.id.slice(-2)}`,
          pause: {
            ...pauses.find((p) => p.agentId === a.id)?.pause,
            midTurn: a.state === 'working',
            saved: true,
            closedQuestion: null,
            blocked: null,
          },
        }) as Agent,
    );
  };

  beforeEach(async () => {
    waiting = [];
    resumeCalls = [];
    stopped.clear();
    members = { [key('claude-code', 'default')]: [OWNER, OTHER] };
    thresholds = await build();
  });

  it('Given 80 % read, When the threshold goes down to 70 %, Then each agent gets a save at once, « dans la minute », and nobody is stopped yet', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    expect(records).toEqual([]);

    await change({ 'claude-code': { 'five-hour': 70 } });

    for (const target of [OWNER, OTHER]) {
      expect(savesTo(target.id).map((r) => r.input.text)).toEqual([saveText('5 h', 80, 70, true)]);
    }
    expect(delivered.filter((d) => d.urgent).map((d) => d.agentId)).toEqual([OWNER.id, OTHER.id]);
    expect(pauses).toEqual([]);
  });

  it('Given that lowered threshold, When 60 s pass, Then every agent is paused, once, with the window and the reset', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    await change({ 'claude-code': { 'five-hour': 70 } });
    await clock.advance(59_000);
    expect(pauses).toEqual([]);
    await clock.advance(1000);

    expect(pauses.map((p) => p.agentId).sort()).toEqual([OWNER.id, OTHER.id].sort());
    expect(pauses[0]?.pause).toEqual(
      has({
        cliId: 'claude-code',
        account: 'default',
        cause: 'threshold',
        windows: [{ id: 'five-hour', label: '5 h', percent: 80, resetsAt: RESET_5H }],
        resumeAt: RESET_5H,
      }),
    );
    await clock.advance(120_000);
    expect(pauses).toHaveLength(2);
  });

  it('Given that lowered threshold, When an agent ends its turn, Then it is paused then, without waiting for the 60 s', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    await change({ 'claude-code': { 'five-hour': 70 } });
    await thresholds.turnFinished(OWNER.id);
    expect(pauses.map((p) => p.agentId)).toEqual([OWNER.id]);
  });

  it('Given 80 % read, When the threshold goes down to 82 %, Then the agents get a save (the band starts at 79 %) and are not stopped', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    await change({ 'claude-code': { 'five-hour': 82 } });
    expect(records.filter((r) => r.input.kind === 'usage-save')).toHaveLength(2);
    await clock.advance(120_000);
    expect(pauses).toEqual([]);
  });

  it('Given a lowered threshold for the week only, When the 5 h window is far from its own, Then only the week counts', async () => {
    await thresholds.onUsage(state([window5h(20), weekly(60)]));
    await change({ 'claude-code': { week: 55 } });
    expect(savesTo(OWNER.id).map((r) => r.input.text)).toEqual([saveText('semaine', 60, 55, true)]);
    await clock.advance(60_000);
    expect(pauses).toHaveLength(2);
    expect(pauses[0]?.pause.windows.map((w) => w.id)).toEqual(['week']);
  });

  it('Given the same thresholds saved again, When setStops runs, Then nothing is sent and nobody is stopped', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    await change({ 'claude-code': { 'five-hour': 90 } });
    await clock.advance(120_000);
    expect(records).toEqual([]);
    expect(pauses).toEqual([]);
  });

  it('Given a threshold lowered for another CLI, When setStops runs, Then the account of Claude is not touched', async () => {
    await thresholds.onUsage(state([window5h(80)]));
    await change({ codex: { 'five-hour': 10 } });
    await clock.advance(120_000);
    expect(records).toEqual([]);
    expect(pauses).toEqual([]);
  });

  it('Given no reading yet, When the threshold changes, Then it is kept and nobody is touched (a CLI without a reading is never stopped)', async () => {
    await change({ 'claude-code': { 'five-hour': 10 } });
    await clock.advance(120_000);
    expect(records).toEqual([]);
    expect(pauses).toEqual([]);
    // The next reading is judged with the new threshold.
    await thresholds.onUsage(state([window5h(5)]));
    expect(records).toEqual([]);
    await thresholds.onUsage(state([window5h(11)]));
    expect(records.filter((r) => r.input.kind === 'usage-save')).toHaveLength(2);
  });

  it('Given a paused account, When the threshold goes above its window, Then every agent resumes (sc. 3) and the account is no longer in pause', async () => {
    await thresholds.onUsage(state([window5h(87)]));
    await thresholds.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    listPaused();
    expect(thresholds.pausedFor('claude-code')).not.toBeNull();

    await change({ 'claude-code': { 'five-hour': 95 } });

    expect(resumeCalls.sort()).toEqual([OWNER.id, OTHER.id].sort());
    expect(thresholds.pausedFor('claude-code')).toBeNull();
    expect(thresholds.usageHeld('claude-code')).toBe(false);
  });

  it('Given a paused account on two windows, When the threshold of one goes up but the other is still at its threshold, Then nobody resumes', async () => {
    await thresholds.onUsage(state([window5h(87), weekly(87)]));
    await thresholds.onUsage(state([window5h(90), weekly(90)]));
    await clock.advance(5000);
    listPaused();

    await change({ 'claude-code': { 'five-hour': 95 } });

    expect(resumeCalls).toEqual([]);
    expect(thresholds.pausedFor('claude-code')).not.toBeNull();
  });

  it('Given a paused account, When the threshold stays at or under the consumption, Then nobody resumes', async () => {
    await thresholds.onUsage(state([window5h(87)]));
    await thresholds.onUsage(state([window5h(90)]));
    await clock.advance(5000);
    listPaused();

    await change({ 'claude-code': { 'five-hour': 90 } });
    await change({ 'claude-code': { 'five-hour': 85 } });

    expect(resumeCalls).toEqual([]);
  });
});
