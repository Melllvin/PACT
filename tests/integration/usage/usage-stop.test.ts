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
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

/** `expect.objectContaining` typed as `unknown`, so it nests in an expected value. */
const has = (fields: object): unknown => expect.objectContaining(fields);

// 009 T017 — US1: `AgentManager.pause` on real worktrees, with the fake CLI, on a temporary repository and a
// bare remote that must stay as it was (research R6; FR-005, SC-003, SC-007; US1 sc.6 and 12).
//
// API fixed here for the dev (see the report, « API fixées »):
//   manager.pause(agentId, pause): Promise<void>
//     `pause` is what the service knows: { cliId, account, cause, windows, resumeAt, pausedAt }. The manager
//     adds `midTurn` (WORKING_STATES before the stop), `saved` (no uncommitted change, measured after the
//     stop by `git.hasUncommittedChanges(worktreePath)`), `closedQuestion` (the open question, 200 characters
//     at most) and `blocked: null`. It stops the process without a crash, saves `state: 'paused'`, `pause`,
//     `lastError: null`, emits `agent:state`, and sets `scheduledResume` to `nextResume(id, resumeAt, 0, now)`
//     when the automatic resume of the workspace is on (null otherwise), replacing the one of a rate limit.
//   manager.restart(agentId) accepts a paused agent: a new session, `pause` back to null.
// PACT writes no Git command here: the only commits are the ones of the fake CLI.

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

/** Time moves only when a test says so; due timers then run. */
class TestClock implements Clock {
  private current = new Date(START);
  private readonly timers = new Set<{ at: number; run: () => void }>();
  now = () => new Date(this.current);
  setTimeout = (run: () => void, ms: number) => {
    const timer = { at: +this.current + ms, run };
    this.timers.add(timer);
    return timer;
  };
  get pending() {
    return this.timers.size;
  }
  clearTimeout = (timer: unknown) => {
    this.timers.delete(timer as { at: number; run: () => void });
  };
}

const pauseInfo = (over: Record<string, unknown> = {}) => ({
  cliId: 'fake',
  account: 'default',
  cause: 'threshold' as const,
  windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: RESET }],
  resumeAt: RESET as string | null,
  pausedAt: START,
  ...over,
});
type Pausing = { pause(agentId: string, pause: ReturnType<typeof pauseInfo>): Promise<void> };
const pause = (manager: AgentManager, id: string, over: Record<string, unknown> = {}) =>
  (manager as unknown as Pausing).pause(id, pauseInfo(over));

let root: string;
let repo: string;
let remote: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let hookUrl: string;
let clock: TestClock;
let events: AgentStateEvent[];
let managers: AgentManager[];
let scenarioFile: string;
let autoResume: boolean;
let counter: number;

const draft = (): AgentDraft => ({
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
});

/** Writes a scenario of the fake CLI of this test; the agents started after it play it. */
const useScenario = async (scenario: Record<string, unknown>) => {
  counter += 1;
  scenarioFile = join(root, `scenario-${String(counter)}.json`);
  await writeFile(scenarioFile, JSON.stringify(scenario));
};

const createManager = async () => {
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  const registry = new CliRegistry({
    adapters: [adapter],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const manager = new AgentManager({
    workspaces,
    registry,
    git: new GitService({ env: gitEnv }),
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () => Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioFile }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    autoResume: () => Promise.resolve(autoResume),
    clock,
    usage: { statusLine: () => 'PACT', follow: () => undefined, release: () => undefined },
  });
  managers.push(manager);
  return manager;
};

const launchOne = async (manager: AgentManager) => {
  const [started] = await manager.launch({
    workspaceId: workspace.id,
    agents: [draft()],
    counters: { freeTerminal: 0 },
  });
  return started as Agent;
};

const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);
const onDisk = async (id: string) =>
  (await stores.workspace(workspace.id).read())?.agents.find((a) => a.id === id);

/** Waits for the announced state: the manager saves a transition before it emits it. */
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

const waitUntil = async (check: () => boolean, what: string) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Starts an agent, types one prompt and waits for the state the scenario leads it to. */
const agentAt = async (manager: AgentManager, state: AgentState) => {
  const started = await launchOne(manager);
  await waitForState(started.id, 'awaiting-prompt');
  if (state !== 'awaiting-prompt') {
    pty.write(started.id, 'Travaille\r');
    await waitForState(started.id, state);
  }
  return started;
};

/** Everything the remote holds, and everything the repository knows of it. */
const remoteRefs = () => git(repo, 'ls-remote', remote);
const localRefs = () => git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-usage-stop-')));
  repo = join(root, 'Dépôt');
  remote = join(root, 'remote.git');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', 'origin', 'main');

  stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  hookUrl = await hooks.start();
  clock = new TestClock();
  events = [];
  managers = [];
  counter = 0;
  autoResume = true;
  scenarioFile = scenarioPath('prompt-then-done');
}, 30_000);

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe('AgentManager.pause: the stop (FR-005, SC-003)', { timeout: 30_000 }, () => {
  it('Given an idle agent, When it is paused, Then its process ends without a crash and it stays paused, never in error', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);

    expect(pty.has(id)).toBe(false);
    expect(current(id)).toMatchObject({
      state: 'paused',
      lastError: null,
      pause: has({
        cliId: 'fake',
        account: 'default',
        cause: 'threshold',
        windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: RESET }],
        resumeAt: RESET,
        pausedAt: START,
        midTurn: false,
        blocked: null,
      }),
    });
    // The exit of the process is read after the stop: it must not turn into a crash.
    await new Promise((r) => setTimeout(r, 400));
    expect(current(id)?.state).toBe('paused');
    expect(current(id)?.lastError).toBeNull();
    expect(events.filter((e) => e.agentId === id).map((e) => e.state)).not.toContain('error');
  });

  it('Given a paused agent, When the state is read from disk and from the events, Then both say paused with the pause (SC-003)', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);

    expect(await onDisk(id)).toMatchObject({
      state: 'paused',
      lastError: null,
      pause: has({ windows: [has({ label: '5 h' })] }),
    });
    expect(events.findLast((e) => e.agentId === id)).toMatchObject({
      state: 'paused',
      pause: has({ resumeAt: RESET }),
    });
  });

  it('Given an agent at work, When it is paused, Then pause.midTurn is true; an idle one has false', async () => {
    await useScenario({ holdMs: 60_000 });
    const manager = await createManager();
    const { id } = await agentAt(manager, 'working');
    await pause(manager, id);
    expect(current(id)?.pause?.midTurn).toBe(true);
    expect(current(id)?.state).toBe('paused');
  });

  it('Given a question open on the agent, When it is paused, Then the question is kept in pause.closedQuestion', async () => {
    scenarioFile = scenarioPath('ask-question');
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-answer');
    await pause(manager, id);
    expect(current(id)).toMatchObject({
      state: 'paused',
      pause: has({ closedQuestion: 'Quelle base de données ?' }),
    });
    expect(current(id)?.awaiting).toBeUndefined();
  });

  it('Given a very long question, When it is paused, Then the kept summary has 200 characters at most', async () => {
    await useScenario({
      signal: { type: 'awaiting-answer', summary: 'Q'.repeat(300), question: true },
    });
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-answer');
    await pause(manager, id);
    const kept = current(id)?.pause?.closedQuestion ?? '';
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept.startsWith('QQQ')).toBe(true);
  });

  it('Given no question, When it is paused, Then closedQuestion is null', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);
    expect(current(id)?.pause?.closedQuestion).toBeNull();
  });
});

describe('AgentManager.pause: nothing saved by PACT (FR-003, SC-007; US1 sc.6, 12)', () => {
  it('Given a worktree with an uncommitted file, When the agent is paused, Then pause.saved is false and PACT made no commit', async () => {
    await useScenario({ files: [{ write: 'travail.txt', content: 'à moitié fait\n' }] });
    const manager = await createManager();
    const started = await agentAt(manager, 'done');
    const head = git(started.worktreePath, 'rev-parse', 'HEAD');
    const refs = localRefs();
    const remoteBefore = remoteRefs();

    await pause(manager, started.id);

    expect(current(started.id)?.pause?.saved).toBe(false);
    expect(git(started.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(started.worktreePath, 'status', '--porcelain')).toContain('travail.txt');
    expect(localRefs()).toBe(refs);
    expect(remoteRefs()).toBe(remoteBefore);
  });

  it('Given an agent that committed on the instruction, When it is paused, Then pause.saved is true and the remote did not change (US1 sc.12)', async () => {
    await useScenario({
      files: [{ write: 'travail.txt', content: 'fait\n' }, { commit: 'pact: sauvegarde' }],
    });
    const manager = await createManager();
    const started = await agentAt(manager, 'done');
    const head = git(started.worktreePath, 'rev-parse', 'HEAD');
    const remoteBefore = remoteRefs();

    await pause(manager, started.id);

    expect(current(started.id)?.pause?.saved).toBe(true);
    expect(git(started.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(started.worktreePath, 'log', '--format=%s', '-1')).toBe('pact: sauvegarde');
    // No push, no branch created on the remote: its refs are byte for byte the same.
    expect(remoteRefs()).toBe(remoteBefore);
    expect(git(remote, 'branch', '--list')).not.toContain('agent/');
  });

  it('Given a clean worktree, When the agent is paused, Then pause.saved is true', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);
    expect(current(id)?.pause?.saved).toBe(true);
  });

  it('Given an untracked file written after the last commit, When the agent is paused, Then pause.saved is false', async () => {
    const manager = await createManager();
    const started = await agentAt(manager, 'awaiting-prompt');
    await writeFile(join(started.worktreePath, 'nouveau.txt'), 'pas commité\n');
    await pause(manager, started.id);
    expect(current(started.id)?.pause?.saved).toBe(false);
  });
});

describe('AgentManager.pause: the resume it schedules (R6, R8)', { timeout: 30_000 }, () => {
  it('Given the automatic resume on, When an agent is paused, Then it holds one scheduled resume at the reset of the pause', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);
    expect(current(id)?.scheduledResume).toEqual({ agentId: id, at: RESET, attempt: 0 });
    expect(clock.pending).toBe(1);
  });

  it('Given the automatic resume off, When an agent is paused, Then nothing is scheduled', async () => {
    autoResume = false;
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);
    expect(current(id)).toMatchObject({ state: 'paused', scheduledResume: null });
    expect(clock.pending).toBe(0);
  });

  it('Given an agent in a rate limit error with its resume scheduled, When it is paused, Then it is paused with a single scheduled resume, the one of the pause (R6)', async () => {
    scenarioFile = scenarioPath('rate-limit');
    const manager = await createManager();
    const started = await launchOne(manager);
    await waitForState(started.id, 'awaiting-prompt');
    pty.write(started.id, 'Travaille\r');
    await waitForState(started.id, 'error');
    await waitUntil(() => !pty.has(started.id), 'the process never ended');
    expect(current(started.id)?.lastError?.kind).toBe('rate-limit');
    expect(clock.pending).toBe(1);

    await pause(manager, started.id);

    expect(current(started.id)).toMatchObject({
      state: 'paused',
      lastError: null,
      scheduledResume: { agentId: started.id, at: RESET, attempt: 0 },
    });
    expect(clock.pending).toBe(1);
    expect(events.findLast((e) => e.agentId === started.id)?.state).toBe('paused');
  });
});

describe('AgentManager.restart of a paused agent (T022)', { timeout: 30_000 }, () => {
  it('Given a paused agent, When the user restarts it, Then a new session starts and the pause and its resume are gone', async () => {
    const manager = await createManager();
    const { id } = await agentAt(manager, 'awaiting-prompt');
    await pause(manager, id);
    expect(current(id)?.state).toBe('paused');

    await manager.restart(id);
    await waitForState(id, 'awaiting-prompt');
    expect(current(id)).toMatchObject({ pause: null, lastError: null, scheduledResume: null });
    expect(clock.pending).toBe(0);
  });
});
