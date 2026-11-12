import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import type { Clock } from '../../../src/main/agents/auto-resume';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { ExchangeService } from '../../../src/main/orchestrator/exchange-service';
import { WakeService } from '../../../src/main/orchestrator/wake-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { TestRunner } from '../../../src/main/review/test-runner';
import { UsageLimitService } from '../../../src/main/usage/usage-limit-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import { MAX_WAKES_PER_HOUR } from '../../../src/shared/exchanges';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import type { UsageState } from '../../../src/shared/usage';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// 009 T049 — the edge cases of the spec, on real worktrees, with the fake CLI and a clock the test drives:
// a free terminal is no agent and is never stopped; a test run by PACT goes on during a pause and its event
// waits in the journal for the orchestrator to be back; the cap of wakes of 007 holds the events, never the
// save instruction (FR-004, FR-010, FR-011; spec « Edge Cases »).

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

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
};
type Account = {
  onUsage(state: UsageState): Promise<void>;
  resumeAccount(cliId: string, account: string): Promise<void>;
  usageHeld(cliId: string): boolean;
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
let manager: AgentManager;
let service: UsageLimitService;
let exchanges: ExchangeService;
let wake: WakeService;
let tests: TestRunner;
/** The pointer lines the wake typed, per agent. */
let typed: { agentId: string; line: string }[];

const draft = (): AgentDraft => ({
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
});

const account = () => service as unknown as Account;

const reading = (percent: number): UsageState => ({
  cliId: 'fake',
  account: 'default',
  reading: {
    cliId: 'fake',
    account: 'default',
    windows: [
      { id: 'five-hour', label: '5 h', usedPercent: percent, resetsAt: RESET, minutes: 300 },
    ],
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
    await sleep(20);
  }
};

const agentAt = async (session: string, role: Agent['role']) => {
  const [started] = await manager.launch({
    workspaceId: workspace.id,
    agents: [draft()],
    counters: { freeTerminal: 0 },
  });
  const agent = started as Agent;
  await waitForState(agent.id, 'awaiting-prompt');
  await workspaces.update(workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => (a.id === agent.id ? { ...a, sessionId: session, role } : a)),
  }));
  return agent;
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-usage-edge-')));
  repo = join(root, 'Dépôt');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  stores = openStores(join(root, 'userData'));
  const git2 = new GitService({ env: gitEnv });
  workspaces = new WorkspaceService({ git: git2, stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  hookUrl = await hooks.start();
  clock = new TestClock();
  events = [];
  typed = [];

  exchanges = new ExchangeService({ workspaces, onChange: () => undefined });
  wake = new WakeService({
    workspaces,
    type: (agentId, line) => typed.push({ agentId, line }),
    inputBusy: () => false,
    setNotice: () => undefined,
    usageHeld: (cliId) => account().usageHeld(cliId),
  });
  exchanges.onRecorded((workspaceId, message) => {
    wake.notify(workspaceId, message);
  });

  const registry = new CliRegistry({
    adapters: [new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform })],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const holder: { service?: UsageLimitService } = {};
  manager = new AgentManager({
    workspaces,
    registry,
    git: git2,
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () =>
      Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done') }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    autoResume: () => Promise.resolve(true),
    clock,
    usage: { statusLine: () => 'PACT', follow: () => undefined, release: () => undefined },
    onPausedDue: (agent: Agent) => {
      if (agent.pause) void holder.service?.resumeAccount(agent.pause.cliId, agent.pause.account);
    },
  });
  const pausing = manager as unknown as Pausing;
  service = new UsageLimitService({
    agents: {
      accountAgents: (cliId: string, acc: string) => manager.accountAgents(cliId, acc),
      pause: (id: string, info: never) => manager.pause(id, info),
      pausedAgents: (cliId: string, acc: string) => pausing.pausedAgents(cliId, acc),
      resumePaused: (id: string) => pausing.resumePaused(id),
      schedule: (id: string, resume: never) => pausing.schedule(id, resume),
    },
    exchanges: { record: (workspaceId, input) => exchanges.record(workspaceId, input) },
    wake,
    git: { indexLock: (path: string) => git2.indexLock(path) },
    cliName: () => 'Faux CLI',
    stores,
    clock,
    autoResume: () => Promise.resolve(true),
    commitFrozen: () => false,
  });
  holder.service = service;
  tests = new TestRunner({
    env: () => Promise.resolve({ PATH: process.env.PATH ?? '' }),
    onUpdate: () => undefined,
  });
}, 30_000);

afterEach(async () => {
  tests.dispose();
  wake.dispose();
  service.dispose();
  await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

/** The account climbs to its threshold: the agents are stopped for real, with a reset at 11:00. */
const stopAccount = async () => {
  await account().onUsage(reading(87));
  await account().onUsage(reading(90));
  await clock.advance(5000);
};

describe('edge cases of the stop at a limit', { timeout: 40_000 }, () => {
  it('Given a free terminal next to an agent, When the account is stopped, Then the agent is paused and the terminal keeps running', async () => {
    const lead = await agentAt('session-lead', 'orchestrator');
    pty.start('free-terminal', {
      // Node rather than a shell: the same long-running process on macOS and on Windows.
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
      cwd: repo,
    });
    await stopAccount();

    expect(current(lead.id)?.state).toBe('paused');
    expect(pty.has('free-terminal')).toBe(true);
    expect(workspaces.get(workspace.id)?.agents.map((a) => a.id)).toEqual([lead.id]);
  });

  it('Given a test run by PACT during a pause, When it ends, Then it finishes and its event waits unread for the orchestrator until the resume', async () => {
    const lead = await agentAt('session-lead', 'orchestrator');
    const worker = await agentAt('session-worker', 'dev');
    await stopAccount();
    expect(current(lead.id)?.state).toBe('paused');
    expect(current(worker.id)?.state).toBe('paused');
    // The save instructions of the climb were typed before the stop: only what follows counts.
    typed.length = 0;

    // The run belongs to PACT, not to the CLI: the pause does not touch it.
    await tests.run(
      { agentId: worker.id, cwd: current(worker.id)?.worktreePath ?? repo, port: null },
      'node -e "setTimeout(() => undefined, 200)"',
      'tree-1',
    );
    const start = Date.now();
    while (tests.latest(worker.id)?.status === 'running') {
      if (Date.now() - start > 10_000) throw new Error('the test run never ended');
      await sleep(20);
    }
    expect(tests.latest(worker.id)?.status).toBe('passed');
    expect(current(worker.id)?.state).toBe('paused');

    // Its event is written for the orchestrator: the journal keeps it, nothing is typed.
    const event = await exchanges.record(workspace.id, {
      from: 'pact',
      to: lead.id,
      kind: 'loop',
      text: 'Les tests du dev sont passés.',
    });
    wake.deliver(lead.id);
    await flush();
    expect(typed).toEqual([]);
    expect(exchanges.unreadOf(workspace.id, lead.id).map((m) => m.id)).toContain(event.id);

    // The reset: the orchestrator is back, and only then the event is pointed to.
    await clock.advance(2 * 3_600_000);
    await waitForState(lead.id, 'awaiting-prompt');
    wake.agentChanged(lead.id);
    await flush();
    expect(typed.filter((t) => t.agentId === lead.id)).toHaveLength(1);
    expect(typed[0]?.line).toMatch(/événement/);
  });

  it('Given the cap of wakes reached, When a save instruction is written, Then it is pointed to at once while an ordinary event stays held', async () => {
    const lead = await agentAt('session-lead', 'orchestrator');
    for (let i = 0; i < MAX_WAKES_PER_HOUR; i++) {
      await exchanges.record(workspace.id, {
        from: 'pact',
        to: lead.id,
        kind: 'loop',
        text: `Événement ${String(i)}`,
      });
      wake.deliver(lead.id);
    }
    expect(typed).toHaveLength(MAX_WAKES_PER_HOUR);

    await exchanges.record(workspace.id, {
      from: 'pact',
      to: lead.id,
      kind: 'loop',
      text: 'Un de trop',
    });
    wake.deliver(lead.id);
    expect(typed).toHaveLength(MAX_WAKES_PER_HOUR);

    await account().onUsage(reading(87));
    await flush();
    expect(typed).toHaveLength(MAX_WAKES_PER_HOUR + 1);
    const saves = exchanges.unreadOf(workspace.id, lead.id).filter((m) => m.kind === 'usage-save');
    expect(saves).toHaveLength(1);
  });
});
