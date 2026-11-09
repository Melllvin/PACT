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
