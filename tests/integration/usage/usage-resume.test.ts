import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import type { Clock } from '../../../src/main/agents/auto-resume';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { UsageLimitService } from '../../../src/main/usage/usage-limit-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import type { UsageState, UsageWindow } from '../../../src/shared/usage';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

/** `expect.objectContaining` typed as `unknown`, so it nests in an expected value. */
const has = (fields: object): unknown => expect.objectContaining(fields);

// 009 T029 — US2: the resume at the reset, a real `AgentManager` and a real `UsageLimitService` on real worktrees,
// with the fake CLI and a clock the test drives (research R8 to R10; FR-006, FR-008; US2 sc.1, 3, 4, 5, 7, 10).
//
// API fixed here for the dev (see the report, « API fixées »):
//   new AgentManager({ …, onPausedDue })        onPausedDue(agent: Agent): void — `resumeDue` of a `paused` agent
//                                               hands it over (T032); here it calls service.resumeAccount(
//                                               agent.pause.cliId, agent.pause.account)
//   manager.pausedAgents(cliId, account)        the agents in `paused` of the account, in every workspace
//   manager.resumePaused(agentId)               `startAgain(workspace, agent, agent.sessionId)`, `pause` back to null;
//                                               'resumed', or 'blocked' when the sessionId is null (pause.blocked:
//                                               'session', scheduledResume null, the agent stays paused)
//   manager.schedule(agentId, resume)           sets or clears `scheduledResume`
//   manager.resume(agentId)                     accepts a paused agent: same as resumePaused (the tile, T032)
//   git.indexLock(worktreePath)                 GitService (T034): the path of the lock if it exists, never erased
//   the service gets { agents: manager, git, cliName } on top of the options of T015; see usage-limit-service.test.ts.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const START = '2030-01-01T09:00:00.000Z';
const RESET = '2030-01-01T11:00:00.000Z';
const HOUR = 3_600_000;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

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

type Pausing = {
  pausedAgents(cliId: string, account: string): Agent[];
  resumePaused(agentId: string): Promise<'resumed' | 'blocked'>;
  schedule(agentId: string, resume: unknown): Promise<void>;
  resume(agentId: string): Promise<void>;
};
type Account = {
  onUsage(state: UsageState): Promise<void>;
  resumeAccount(cliId: string, account: string): Promise<void>;
};

let root: string;
let repo: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let hookUrl: string;
let clock: TestClock;
let events: AgentStateEvent[];
let managers: AgentManager[];
let services: UsageLimitService[];
let scenarioFile: string;
let counter: number;
let records: { workspaceId: string; input: Record<string, unknown> }[];
let delivered: { agentId: string; urgent: boolean }[];
let order: string[];
let locks: GitService;

const draft = (): AgentDraft => ({
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
});

const useScenario = async (scenario: Record<string, unknown>) => {
  counter += 1;
  scenarioFile = join(root, `scenario-${String(counter)}.json`);
  await writeFile(scenarioFile, JSON.stringify(scenario));
};

/** A manager and its service, wired as the main process does: the manager hands a due pause to the service. */
const build = async (ptyManager = pty) => {
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  const registry = new CliRegistry({
    adapters: [adapter],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const holder: { service?: UsageLimitService } = {};
  const wiring = {
    onPausedDue: (agent: Agent) => {
      if (agent.pause)
        void (holder.service as unknown as Account).resumeAccount(
          agent.pause.cliId,
          agent.pause.account,
        );
    },
  };
  const manager = new AgentManager({
    workspaces,
    registry,
    git: locks,
    pty: ptyManager,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () => Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioFile }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    autoResume: () => Promise.resolve(true),
    clock,
    usage: { statusLine: () => 'PACT', follow: () => undefined, release: () => undefined },
    ...wiring,
  });
  managers.push(manager);
  const pausing = manager as unknown as Pausing;
  const options = {
    agents: {
      accountAgents: (cliId: string, account: string) => manager.accountAgents(cliId, account),
      pause: (id: string, info: never) => manager.pause(id, info),
      pausedAgents: (cliId: string, account: string) => pausing.pausedAgents(cliId, account),
      resumePaused: (id: string) => {
        order.push(id);
        return pausing.resumePaused(id);
      },
      schedule: (id: string, resume: unknown) => pausing.schedule(id, resume),
    },
    exchanges: {
      record: (workspaceId: string, input: Record<string, unknown>) => {
        records.push({ workspaceId, input });
        return Promise.resolve({});
      },
    },
    wake: {
      deliver: (agentId: string, wake?: { urgent?: boolean }) => {
        delivered.push({ agentId, urgent: wake?.urgent === true });
      },
    },
    git: {
      indexLock: (path: string) =>
        (locks as unknown as { indexLock(p: string): Promise<string | null> }).indexLock(path),
    },
    cliName: () => 'Faux CLI',
    stores,
    clock,
    autoResume: () => Promise.resolve(true),
    commitFrozen: () => false,
  };
  const service = new UsageLimitService(options);
  holder.service = service;
  services.push(service);
  return { manager, service: service as unknown as Account };
};

const window5h = (percent: number): UsageWindow => ({
  id: 'five-hour',
  label: '5 h',
  usedPercent: percent,
  resetsAt: RESET,
  minutes: 300,
});
const reading = (percent: number): UsageState => ({
  cliId: 'fake',
  account: 'default',
  reading: {
    cliId: 'fake',
    account: 'default',
    windows: [window5h(percent)],
    readAt: clock.now().toISOString(),
  },
  shares: [],
  level: 'ok',
});

const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);
const waitForState = async (id: string, state: AgentState, timeoutMs = 10_000) => {
  const start = Date.now();
  const announced = () => events.findLast((e) => e.agentId === id)?.state;
  while (current(id)?.state !== state || announced() !== state) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `${id} stayed ${String(current(id)?.state)} instead of ${state}\n${pty.history(id)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

const launchOne = async (manager: AgentManager) => {
  const [started] = await manager.launch({
    workspaceId: workspace.id,
    agents: [draft()],
    counters: { freeTerminal: 0 },
  });
  return started as Agent;
};
/** Starts an agent, with a session id the test chose, and waits for the state the scenario leads it to. */
const agentAt = async (manager: AgentManager, state: AgentState, session: string) => {
  const started = await launchOne(manager);
  await waitForState(started.id, 'awaiting-prompt');
  await setSession(started.id, session);
  if (state !== 'awaiting-prompt') {
    pty.write(started.id, 'Travaille\r');
    await waitForState(started.id, state);
  }
  return started;
};
const setSession = async (id: string, sessionId: string | null) => {
  await workspaces.update(workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => (a.id === id ? { ...a, sessionId } : a)),
  }));
};
const setRole = async (id: string, role: Agent['role']) => {
  await workspaces.update(workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => (a.id === id ? { ...a, role } : a)),
  }));
};

/** The account climbs to its threshold: the agents are stopped for real, with a reset at 11:00. */
const stopAccount = async (service: Account) => {
  await service.onUsage(reading(87));
  await service.onUsage(reading(90));
  await clock.advance(5000);
};
const notices = (agentId: string) =>
  records.filter((r) => r.input.kind === 'usage-resumed' && r.input.to === agentId);

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-usage-resume-')));
  repo = join(root, 'Dépôt');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  stores = openStores(join(root, 'userData'));
  locks = new GitService({ env: gitEnv });
  workspaces = new WorkspaceService({ git: locks, stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  hookUrl = await hooks.start();
  clock = new TestClock();
  events = [];
  managers = [];
  services = [];
  records = [];
  delivered = [];
  order = [];
  counter = 0;
  scenarioFile = scenarioPath('prompt-then-done');
}, 30_000);

afterEach(async () => {
  for (const service of services) service.dispose();
  for (const manager of managers) await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe('the resume at the reset (US2 sc.1, 3, 7, 10)', { timeout: 40_000 }, () => {
  it('Given two paused agents, When the clock reaches the reset, Then each one starts again in its own session with --resume, the orchestrator first, and nothing counts as a turn', async () => {
    const { manager, service } = await build();
    const lead = await agentAt(manager, 'awaiting-prompt', 'session-lead');
    const worker = await agentAt(manager, 'awaiting-prompt', 'session-worker');
    await setRole(lead.id, 'orchestrator');
    await setRole(worker.id, 'dev');
    await stopAccount(service);
    expect(current(lead.id)?.state).toBe('paused');
    expect(current(worker.id)?.state).toBe('paused');
    const seen = events.length;

    await clock.advance(2 * HOUR);

    await waitForState(lead.id, 'awaiting-prompt');
    await waitForState(worker.id, 'awaiting-prompt');
    expect(pty.history(lead.id)).toContain('Session reprise session-lead');
    expect(pty.history(worker.id)).toContain('Session reprise session-worker');
    expect(current(lead.id)).toMatchObject({ pause: null, scheduledResume: null, lastError: null });
    // The orchestrator starts before the agent it coordinates.
    expect(order).toEqual([lead.id, worker.id]);
    const starts = events
      .slice(seen)
      .filter((e) => e.state === 'starting')
      .map((e) => e.agentId);
    expect(starts).toEqual([lead.id, worker.id]);
    // The pause is no turn: no agent went through « done » or « error » between the stop and the resume.
    const states = events.slice(seen).map((e) => e.state);
    expect(states).not.toContain('error');
    expect(states).not.toContain('done');
    expect(records.filter((r) => r.input.kind === 'report-missing')).toEqual([]);
  });

  it('Given an agent stopped mid-turn and an idle one, When they resume, Then only the first gets an action and a wake, the other an info (US2 sc.3)', async () => {
    const { manager, service } = await build();
    await useScenario({ holdMs: 60_000 });
    const busy = await agentAt(manager, 'working', 'session-busy');
    scenarioFile = scenarioPath('prompt-then-done');
    const idle = await agentAt(manager, 'awaiting-prompt', 'session-idle');
    await stopAccount(service);
    expect(current(busy.id)?.pause?.midTurn).toBe(true);
    expect(current(idle.id)?.pause?.midTurn).toBe(false);

    await clock.advance(2 * HOUR);
    await waitForState(busy.id, 'awaiting-prompt');
    await waitForState(idle.id, 'awaiting-prompt');

    expect(notices(busy.id)).toEqual([
      { workspaceId: workspace.id, input: has({ type: 'action' }) },
    ]);
    expect(notices(idle.id)).toEqual([{ workspaceId: workspace.id, input: has({ type: 'info' }) }]);
    expect(delivered.map((d) => d.agentId)).toContain(busy.id);
    expect(delivered.filter((d) => !d.urgent).map((d) => d.agentId)).not.toContain(idle.id);
  });

  it('Given a Git lock in the worktree, When the agent resumes, Then the lock is reported to it and PACT leaves the file where it is', async () => {
    const { manager, service } = await build();
    const started = await agentAt(manager, 'awaiting-prompt', 'session-locked');
    await stopAccount(service);
    const lockPath = git(started.worktreePath, 'rev-parse', '--git-path', 'index.lock');
    const lockFile = isAbsolute(lockPath) ? lockPath : join(started.worktreePath, lockPath);
    await writeFile(lockFile, '');

    await clock.advance(2 * HOUR);
    await waitForState(started.id, 'awaiting-prompt');

    expect(existsSync(lockFile)).toBe(true);
    const [notice] = notices(started.id);
    expect(notice?.input.text).toContain(
      `Verrou Git trouvé dans ${started.worktreePath} : vérifie-le avant de committer, PACT ne l'a pas effacé.`,
    );
  });
});

describe('a restart of PACT during the pause (US2 sc.4, FR-006)', { timeout: 40_000 }, () => {
  it('Given a pause and a reset passed while PACT was closed, When PACT opens again, Then the agent is resumed at once with --resume', async () => {
    const first = await build();
    const started = await agentAt(first.manager, 'awaiting-prompt', 'session-night');
    await stopAccount(first.service);
    expect(current(started.id)?.state).toBe('paused');
    services.pop()?.dispose();
    await first.manager.dispose();
    await clock.advance(3 * HOUR);

    workspaces.dispose();
    workspaces = new WorkspaceService({ git: locks, stores });
    await workspaces.restore();
    const second = await build(new PtyManager());
    await second.manager.restore(workspace.id);

    await waitForState(started.id, 'awaiting-prompt');
    expect(current(started.id)).toMatchObject({ pause: null, scheduledResume: null });
    expect(events.filter((e) => e.agentId === started.id).map((e) => e.state)).not.toContain(
      'error',
    );
  });
});

describe('a session that is not known (US2 sc.5)', { timeout: 40_000 }, () => {
  it('Given a paused agent without a session id, When the resume is due, Then it stays paused with blocked: session and « Relancer » starts a new session', async () => {
    const { manager, service } = await build();
    const started = await agentAt(manager, 'awaiting-prompt', 'session-lost');
    await stopAccount(service);
    await setSession(started.id, null);

    await clock.advance(2 * HOUR);
    await new Promise((r) => setTimeout(r, 300));

    expect(current(started.id)).toMatchObject({
      state: 'paused',
      scheduledResume: null,
      pause: has({ blocked: 'session' }),
    });
    expect(notices(started.id)).toEqual([]);

    await manager.restart(started.id);
    await waitForState(started.id, 'awaiting-prompt');
    expect(current(started.id)).toMatchObject({ pause: null, scheduledResume: null });
  });
});

describe('« Reprendre » on the tile of a paused agent (T032)', { timeout: 40_000 }, () => {
  it('Given a paused agent, When the user resumes it, Then it starts again in its session instead of being refused', async () => {
    const { manager, service } = await build();
    const started = await agentAt(manager, 'awaiting-prompt', 'session-tile');
    await stopAccount(service);

    await (manager as unknown as Pausing).resume(started.id);
    await waitForState(started.id, 'awaiting-prompt');

    expect(pty.history(started.id)).toContain('Session reprise session-tile');
    expect(current(started.id)).toMatchObject({ pause: null, scheduledResume: null });
  });
});
