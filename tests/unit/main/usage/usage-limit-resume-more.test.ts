import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../../../src/main/agents/auto-resume';
import { openStores, type Stores } from '../../../../src/main/persistence/store';
import { UsageLimitService } from '../../../../src/main/usage/usage-limit-service';
import type { Agent, ScheduledResume } from '../../../../src/shared/model';
import type { UsageState, UsageWindow } from '../../../../src/shared/usage';
import type { UsagePause } from '../../../../src/shared/usage-limit';

// 009 T028 (complement) — the cases of the resume the main tests of the service do not reach: a pause
// the service does not remember (PACT restarted), several windows, a lock that cannot be read,
// repeated resumes by hand, an automatic resume that is off everywhere.

const START = '2030-01-01T09:00:00.000Z';
const RESET_5H = '2030-01-01T11:00:00.000Z';
const RESET_WEEK = '2030-01-05T09:00:00.000Z';
const RESET_OPUS = '2030-01-03T09:00:00.000Z';

class TestClock implements Clock {
  current = new Date(START);
  now = () => new Date(this.current);
  setTimeout = () => ({});
  clearTimeout = () => undefined;
}

const window = (id: string, label: string, percent: number, resetsAt: string): UsageWindow => ({
  id,
  label,
  usedPercent: percent,
  resetsAt,
  minutes: 300,
});
const five = (percent: number) => window('five-hour', '5 h', percent, RESET_5H);
const week = (percent: number) => window('week', 'semaine', percent, RESET_WEEK);
const opus = (percent: number) => window('seven_day_opus', 'semaine · Opus', percent, RESET_OPUS);

const pauseOf = (over: Partial<UsagePause> = {}): UsagePause => ({
  cliId: 'claude-code',
  account: 'default',
  cause: 'threshold',
  windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: RESET_5H }],
  resumeAt: RESET_5H,
  pausedAt: START,
  midTurn: true,
  saved: true,
  closedQuestion: null,
  blocked: null,
  ...over,
});
const paused = (n: number, over: Partial<Agent> = {}): Agent =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    workspaceId: 'w1',
    position: n,
    cliId: 'claude-code',
    role: 'dev',
    name: `Claude ${String(n)}`,
    worktreePath: `/wt/${String(n)}`,
    launchedBy: null,
    state: 'paused',
    pause: pauseOf(),
    ...over,
  }) as Agent;

let root: string;
let stores: Stores;
let clock: TestClock;
let waiting: Agent[];
let resumeCalls: string[];
let schedules: { agentId: string; resume: ScheduledResume | null }[];
let records: { workspaceId: string; input: Record<string, unknown> }[];
let autoResume: boolean;
let lockFails: boolean;
/** Listed as paused although their `pause` is null. */
let blind: Agent[];
let service: UsageLimitService;

const state = (windows: UsageWindow[]): UsageState => ({
  cliId: 'claude-code',
  account: 'default',
  reading: {
    cliId: 'claude-code',
    account: 'default',
    windows,
    readAt: clock.now().toISOString(),
  },
  shares: [],
  level: 'ok',
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pact-usage-more-'));
  stores = openStores(root);
  clock = new TestClock();
  waiting = [];
  resumeCalls = [];
  schedules = [];
  records = [];
  autoResume = true;
  lockFails = false;
  blind = [];
  service = new UsageLimitService({
    agents: {
      accountAgents: () => [],
      pause: () => Promise.resolve(),
      pausedAgents: (cliId, account) => [
        ...waiting.filter((a) => a.pause?.cliId === cliId && a.pause.account === account),
        ...blind,
      ],
      resumePaused: (agentId) => {
        resumeCalls.push(agentId);
        waiting = waiting.filter((a) => a.id !== agentId);
        return Promise.resolve('resumed' as const);
      },
      schedule: (agentId, resume) => {
        schedules.push({ agentId, resume });
        return Promise.resolve();
      },
    },
    exchanges: {
      record: (workspaceId, input) => {
        records.push({ workspaceId, input: input });
        return Promise.resolve({});
      },
    },
    wake: { deliver: () => undefined },
    git: {
      indexLock: () =>
        lockFails ? Promise.reject(new Error('git a échoué')) : Promise.resolve(null),
    },
    cliName: () => 'Claude',
    stores,
    clock,
    autoResume: () => Promise.resolve(autoResume),
    commitFrozen: () => false,
  });
});

afterEach(async () => {
  service.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('the resume of a pause the service does not remember (PACT restarted)', () => {
  it('Given agents paused before a restart and a window still at its threshold, When the resume is due, Then each waits for that reset, once, and the account is not remembered as paused', async () => {
    waiting = [
      paused(21),
      paused(22, { scheduledResume: { agentId: 'x', at: RESET_WEEK, attempt: 0 } }),
    ];
    await service.onUsage(state([week(91)]));
    clock.current = new Date('2030-01-01T12:00:00.000Z');
    await service.resumeAccount('claude-code', 'default');

    expect(schedules.map((s) => s.agentId)).toEqual([waiting[0]?.id]);
    expect(resumeCalls).toEqual([]);
    expect(service.pausedFor('claude-code')).toBeNull();
  });

  it('Given two windows at their threshold with different resets, When the resume is due, Then the agents wait for the later one', async () => {
    waiting = [paused(21)];
    await service.onUsage(state([week(91), opus(95)]));
    clock.current = new Date('2030-01-01T12:00:00.000Z');
    await service.resumeAccount('claude-code', 'default');
    expect(schedules).toEqual([
      { agentId: waiting[0]?.id, resume: expect.objectContaining({ at: RESET_WEEK }) as unknown },
    ]);
  });

  it('Given an automatic resume off in every workspace, When a timer falls due, Then nobody resumes and nothing is recorded', async () => {
    waiting = [paused(21), paused(22)];
    autoResume = false;
    await service.resumeAccount('claude-code', 'default');
    expect(resumeCalls).toEqual([]);
    expect(schedules).toEqual([]);
    expect((await stores.state.read()).usageLimit.resumed).toEqual([]);
  });

  it('Given no agent in pause, When the resume is due, Then nothing happens', async () => {
    await service.resumeAccount('claude-code', 'default');
    await service.resumeByHand('claude-code', 'default');
    expect(resumeCalls).toEqual([]);
    expect((await stores.state.read()).usageLimit.overrides).toEqual([]);
  });
});

describe('a restart of PACT with agents in pause (R9)', () => {
  it('Given a new service and persisted paused agents, When the pauses are restored, Then the account is in pause and holds the wakes before any reading', () => {
    expect(service.pausedFor('claude-code')).toBeNull();
    service.restorePauses([
      paused(21),
      paused(22, { state: 'working', pause: null }),
      paused(23, { pause: null }),
    ]);
    expect(service.pausedFor('claude-code')).toMatchObject({
      cliId: 'claude-code',
      account: 'default',
      resumeAt: RESET_5H,
    });
    expect(service.usageHeld('claude-code')).toBe(true);
    expect(service.usageHeld('codex')).toBe(false);
    expect(service.pauses()).toHaveLength(1);
  });
});

describe('an account whose paused agents left the pause another way', () => {
  it('Given the only paused agent relaunched by the user, When its state changes, Then the account is no longer in pause', () => {
    waiting = [paused(21)];
    service.restorePauses(waiting);
    expect(service.pausedFor('claude-code')).not.toBeNull();
    service.agentChanged();
    expect(service.pausedFor('claude-code')).not.toBeNull();
    // « Relancer » (or a close) takes it out of the pause without the account's resume.
    waiting = [];
    service.agentChanged();
    expect(service.pausedFor('claude-code')).toBeNull();
    expect(service.usageHeld('claude-code')).toBe(false);
    expect(service.pauses()).toEqual([]);
  });
});

describe('the notices when several things are true at once', () => {
  it('Given a pause on two windows, When the agent resumes, Then the notice names the most loaded one', async () => {
    waiting = [
      paused(21, {
        pause: pauseOf({
          windows: [
            { id: 'five-hour', label: '5 h', percent: 90, resetsAt: RESET_5H },
            { id: 'week', label: 'semaine', percent: 93, resetsAt: RESET_5H },
            { id: 'x', label: 'autre', percent: 91, resetsAt: RESET_5H },
          ],
        }),
      }),
    ];
    await service.resumeByHand('claude-code', 'default');
    expect(records[0]?.input.text).toContain('limite semaine (93 %)');
  });

  it('Given a Git lock that cannot be read, When the agent resumes, Then it resumes all the same and is told nothing of a lock', async () => {
    waiting = [paused(21)];
    lockFails = true;
    await service.resumeByHand('claude-code', 'default');
    expect(resumeCalls).toHaveLength(1);
    expect(records[0]?.input.text).not.toContain('Verrou');
  });

  it('Given a paused agent whose pause data is gone, When the account resumes, Then it is started again and gets no notice', async () => {
    blind = [paused(21, { pause: null })];
    await service.resumeByHand('claude-code', 'default');
    expect(resumeCalls).toHaveLength(1);
    expect(records).toEqual([]);
  });
});

describe('« Reprendre » several times, from the tile', () => {
  it('Given an account resumed by hand twice, When the overrides are read, Then there is one for the account and the last resume is the one kept', async () => {
    waiting = [paused(21)];
    await service.resumeByHand('claude-code', 'default');
    waiting = [paused(22)];
    clock.current = new Date('2030-01-01T09:10:00.000Z');
    await service.resumeByHand('claude-code', 'default');
    const { usageLimit } = await stores.state.read();
    expect(usageLimit.overrides).toHaveLength(1);
    expect(usageLimit.resumed).toEqual([
      { cliId: 'claude-code', account: 'default', at: '2030-01-01T09:10:00.000Z' },
    ]);
  });

  it('Given a pause the service remembers, When one agent is resumed by its id alone, Then it is found, and the account is forgotten once nobody is left', async () => {
    waiting = [paused(21)];
    await service.onUsage(state([five(87)]));
    // The stop made the service remember the pause: simulate it through a stop of its own.
    const memory = service as unknown as { paused: Map<string, unknown> };
    memory.paused.set('claude-code\u0000default', pauseOf());
    expect(service.pausedFor('claude-code')).not.toBeNull();

    await service.resumeAgent(waiting[0]?.id ?? '');
    expect(resumeCalls).toHaveLength(1);
    expect(service.pausedFor('claude-code')).toBeNull();
  });

  it('Given an id that is paused nowhere, When it is resumed, Then nothing is written', async () => {
    await service.resumeAgent('00000000-0000-4000-8000-000000000099');
    expect(resumeCalls).toEqual([]);
    expect((await stores.state.read()).usageLimit.overrides).toEqual([]);
  });

  it('Given an agent handed over by the manager and a first override of its own, When it is resumed again, Then one override remains', async () => {
    const agent = paused(21);
    waiting = [agent, paused(22)];
    await service.resumeAgent(agent.id, agent);
    waiting = [agent];
    await service.resumeAgent(agent.id, agent);
    const { usageLimit } = await stores.state.read();
    expect(usageLimit.overrides.filter((o) => o.agentId === agent.id)).toHaveLength(1);
  });
});
