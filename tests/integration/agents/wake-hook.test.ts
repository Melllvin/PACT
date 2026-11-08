import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer, type HookHandler } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import type { WakeService } from '../../../src/main/orchestrator/wake-service';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { IpcEvent } from '../../../src/shared/ipc';
import type { AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let manager: AgentManager;
let adapter: FakeAdapter;
let events: AgentStateEvent[];
let branches: IpcEvent<'agent:branch'>[];
let scenario: string;

const createManager = async () => {
  const registry = new CliRegistry({
    adapters: [adapter],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const hookUrl = await hooks.start();
  return new AgentManager({
    workspaces,
    registry,
    git: new GitService({ env: gitEnv }),
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () => Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioPath(scenario) }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    onBranch: (event) => branches.push(event),
  });
};

const launchOne = async () => {
  const [agent] = await manager.launch({
    workspaceId: workspace.id,
    agents: [
      {
        cliId: 'fake',
        model: null,
        permissionLevel: 'always-allow',
        baseBranch: null,
        branch: null,
        port: null,
        startCommand: null,
      },
    ],
    counters: { freeTerminal: 0 },
  });
  if (!agent) throw new Error('no agent launched');
  await waitForState(agent.id, 'awaiting-prompt');
  return agent;
};

const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);

const waitFor = async (check: () => boolean, what: string, id: string, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${what}\n${pty.history(id)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Waits for the announced state: the manager saves a transition before it emits it. */
const waitForState = (id: string, state: AgentState) =>
  waitFor(
    () => current(id)?.state === state && events.findLast((e) => e.agentId === id)?.state === state,
    `${id} stayed ${String(current(id)?.state)} instead of ${state}`,
    id,
  );

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-wakehook-')));
  repo = join(root, 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  events = [];
  branches = [];
  scenario = 'prompt-then-done';
  manager = await createManager();
}, 30_000);

afterEach(async () => {
  await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

// 007 T033 — the wake by the reply of a hook (US2 sc.1, 2, 4; FR-018; contracts/hooks.md « Handler »):
// the handler of `AgentManager.start` asks the wake for a pointer BEFORE it applies the signal.
// A Stop that carries a pointer is answered `{ decision: 'block', reason }`, the agent stays
// `working`, no end of turn is applied (so no `turn-finished`, hence no `report-missing`), and the
// terminal is never written. The WakeService is a stub here: its rules are those of T032.
//
// API fixed here for the dev (see the report, « API fixées »):
//   the manager calls `wake.takeForHook(agent.id, point)` (set by `manager.setWake`) only when the
//   adapter says `midTurnWake` and `isWakePoint(payload)` gave a point; a pointer is answered by
//   `adapter.wakeReply(payload, pointer)` and the signal is NOT applied; otherwise it goes on as today.
// The handler is the one the manager registered with the HookServer, called as the server would.

let handlers: Map<string, HookHandler>;
let takeForHook: ReturnType<
  typeof vi.fn<(agentId: string, point: 'tool' | 'stop') => string | null>
>;
const POINTER = '1 événement, lis get_events';

const wire = () => {
  handlers = new Map();
  const register = hooks.register.bind(hooks);
  vi.spyOn(hooks, 'register').mockImplementation((id, handler, statusLine) => {
    handlers.set(id, handler);
    return register(id, handler, statusLine);
  });
  takeForHook = vi.fn<(agentId: string, point: 'tool' | 'stop') => string | null>(() => null);
  manager.setWake({ takeForHook, agentChanged: vi.fn() } as unknown as WakeService);
};

/** A hook as the server hands it to the handler of the agent; the answer is what the CLI receives. */
const fire = async (id: string, payload: unknown) => {
  const handler = handlers.get(id);
  if (!handler) throw new Error('no hook handler registered');
  return await Promise.resolve(handler(payload));
};

/** The agent is in a turn: the prompt reached the hook, the terminal is left alone. */
const startTurn = async (id: string) => {
  await fire(id, { type: 'prompt-submitted', prompt: 'Travaille' });
  await waitForState(id, 'working');
};

/**
 * Proves that nothing was applied: a signal sent after the hook is applied after it, so once its
 * state is there, an end of turn applied by the hook would have shown (state `done`) before it.
 */
const settle = async (id: string) => {
  await fire(id, { type: 'awaiting-answer', summary: 'Sentinelle' });
  await waitForState(id, 'awaiting-answer');
};

const statesOf = (id: string) => events.filter((e) => e.agentId === id).map((e) => e.state);

describe('a hook that carries the pointer (US2 sc.1, sc.2)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    wire();
  });

  it('Given an agent at work, When its Stop finds a pointer, Then the hook answers a block whose reason is the pointer', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    takeForHook.mockReturnValueOnce(POINTER);

    const reply = await fire(agent.id, { type: 'turn-finished' });

    expect(takeForHook).toHaveBeenCalledWith(agent.id, 'stop');
    expect(reply).toEqual({ decision: 'block', reason: POINTER });
  });

  it('Given a Stop prolonged by a wake, When the signal is not applied, Then the agent stays working, with no end of turn and no report missing (FR-018)', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    events.length = 0;
    takeForHook.mockReturnValueOnce(POINTER);

    const reply = await fire(agent.id, { type: 'turn-finished' });
    expect(reply).toEqual({ decision: 'block', reason: POINTER });
    await settle(agent.id);

    expect(statesOf(agent.id)).not.toContain('done');
    expect(statesOf(agent.id)).not.toContain('awaiting-prompt');
    expect(statesOf(agent.id)).toEqual(['awaiting-answer']);
  });

  it('Given the agent goes on after the block, When its second Stop finds nothing new, Then the hook answers {} and the turn ends as it always did', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    takeForHook.mockReturnValueOnce(POINTER).mockReturnValue(null);

    expect(await fire(agent.id, { type: 'turn-finished' })).toEqual({
      decision: 'block',
      reason: POINTER,
    });
    expect(current(agent.id)?.state).toBe('working');

    const second = await fire(agent.id, { type: 'turn-finished' });
    expect(second).toEqual({});
    expect(takeForHook).toHaveBeenCalledTimes(2);
    await waitForState(agent.id, 'done');
  });

  it('Given an agent at work, When a tool ends with a pointer waiting, Then the hook answers additionalContext and the state does not move', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    events.length = 0;
    takeForHook.mockReturnValueOnce(POINTER);

    const reply = await fire(agent.id, { type: 'post-tool' });

    expect(takeForHook).toHaveBeenCalledWith(agent.id, 'tool');
    expect(reply).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: POINTER },
    });
    await settle(agent.id);
    expect(statesOf(agent.id)).toEqual(['awaiting-answer']);
  });

  it('Given a tool that ends with nothing to announce, When the hook fires, Then it answers {} and the state does not move', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    events.length = 0;

    const reply = await fire(agent.id, { type: 'post-tool' });

    expect(takeForHook).toHaveBeenCalledWith(agent.id, 'tool');
    expect(reply).toEqual({});
    await settle(agent.id);
    expect(statesOf(agent.id)).toEqual(['awaiting-answer']);
  });
});

describe('a Stop without pointer behaves as today', { timeout: 30_000 }, () => {
  beforeEach(() => {
    wire();
  });

  it('Given nothing to announce, When Stop fires, Then the wake was asked, the hook answers {} and the turn ends', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);

    const reply = await fire(agent.id, { type: 'turn-finished' });

    expect(takeForHook).toHaveBeenCalledWith(agent.id, 'stop');
    expect(reply).toEqual({});
    await waitForState(agent.id, 'done');
  });
});

describe('nothing is written in the terminal on the hook path (Q10)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    wire();
  });

  it('Given pointers carried by PostToolUse and Stop, When the hooks answer, Then the pty is not written and the history does not grow', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    const before = pty.history(agent.id);
    const write = vi.spyOn(pty, 'write');
    takeForHook.mockReturnValue(POINTER);

    expect(await fire(agent.id, { type: 'post-tool' })).toMatchObject({
      hookSpecificOutput: { additionalContext: POINTER },
    });
    expect(await fire(agent.id, { type: 'turn-finished' })).toEqual({
      decision: 'block',
      reason: POINTER,
    });
    await settle(agent.id);

    expect(write).not.toHaveBeenCalled();
    expect(pty.history(agent.id)).toBe(before);
  });
});

describe('a subagent or a teammate gets no pointer (US2 sc.4)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    wire();
  });

  it('Given hooks with an agent_id, When they fire, Then the wake is not even asked and the hook answers {}', async () => {
    const agent = await launchOne();
    await startTurn(agent.id);
    takeForHook.mockReturnValue(POINTER);
    // The lead itself is asked: the stub is wired and the adapter does reach it.
    expect(await fire(agent.id, { type: 'post-tool' })).toMatchObject({
      hookSpecificOutput: { additionalContext: POINTER },
    });
    expect(takeForHook).toHaveBeenCalledTimes(1);

    expect(await fire(agent.id, { type: 'post-tool', agent_id: 'sub-1' })).toEqual({});
    expect(await fire(agent.id, { type: 'turn-finished', agent_id: 'sub-1' })).toEqual({});
    expect(takeForHook).toHaveBeenCalledTimes(1);
  });
});

describe('a CLI that cannot carry a pointer in a turn', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    vi.stubEnv('FAKE_CLI_NO_WAKE_HOOK', '1');
    await manager.dispose();
    await hooks.stop();
    adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
    manager = await createManager();
    wire();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('Given FAKE_CLI_NO_WAKE_HOOK=1, When its Stop fires, Then the wake is not asked, the hook answers {} and the turn ends (the pointer is typed at the end of the turn)', async () => {
    expect((adapter as unknown as { midTurnWake?: boolean }).midTurnWake).toBe(false);
    const agent = await launchOne();
    await startTurn(agent.id);
    takeForHook.mockReturnValue(POINTER);

    expect(await fire(agent.id, { type: 'post-tool' })).toEqual({});
    expect(await fire(agent.id, { type: 'turn-finished' })).toEqual({});
    expect(takeForHook).not.toHaveBeenCalled();
    await waitForState(agent.id, 'done');
  });
});
