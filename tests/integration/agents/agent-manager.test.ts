import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import type { AgentSignal, OutputContext } from '../../../src/main/agents/adapters/types';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager, type PtySpawnOptions } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { Agent, AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// US2 — agents launched with the fake CLI in real worktrees and pseudo-terminals (T054).

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const baseEnv: Record<string, string> = { ...gitEnv };

/** Prints `? Exécuter : …`: shows the terminal fallback when a CLI has no hook for a dialog. */
class TerminalDialogFake extends FakeAdapter {
  // No hook reports the dialog: the terminal output alone must.
  override mapHookEvent(payload: unknown): AgentSignal | null {
    const signal = super.mapHookEvent(payload);
    return signal?.type === 'awaiting-answer' ? null : signal;
  }

  override mapOutput(chunk: string): AgentSignal | null {
    const match = /\? Exécuter : (.+) \(allow\/deny\)/.exec(chunk);
    return match?.[1] ? { type: 'awaiting-answer', summary: match[1] } : null;
  }
}

/** A CLI without dialog hooks, whose questions only show as idle output (generic adapter, T099). */
class IdleQuestionFake extends FakeAdapter {
  readonly contexts: OutputContext[] = [];

  override mapHookEvent(payload: unknown): AgentSignal | null {
    const signal = super.mapHookEvent(payload);
    return signal?.type === 'awaiting-answer' ? null : signal;
  }

  override mapOutput(chunk: string, ctx: OutputContext): AgentSignal | null {
    this.contexts.push(ctx);
    const match = /\? Exécuter : (.+) \(allow\/deny\)\s*$/.exec(chunk);
    return match?.[1] && ctx.idleMs !== undefined
      ? { type: 'awaiting-answer', summary: match[1] }
      : null;
  }
}

let root: string;
let repo: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let hookUrl: string;
let events: AgentStateEvent[];
let managers: AgentManager[];
let scenario: string;
let shellEnv: Record<string, string>;
let portsInUse: Set<number>;

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
  ...overrides,
});

const createManager = async ({
  adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform }),
  ptyManager = pty,
  service = workspaces,
  idleMs = undefined as number | undefined,
  orchestrator = undefined as ConstructorParameters<typeof AgentManager>[0]['orchestrator'],
  gitService = new GitService({ env: gitEnv }),
  fetchTimeoutMs = undefined as number | undefined,
  usage = undefined as ConstructorParameters<typeof AgentManager>[0]['usage'],
} = {}) => {
  const registry = new CliRegistry({
    adapters: [adapter],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const manager = new AgentManager({
    workspaces: service,
    registry,
    git: gitService,
    ...(fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs }),
    pty: ptyManager,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () => Promise.resolve({ ...shellEnv, FAKE_CLI_SCENARIO: scenarioPath(scenario) }),
    isPortInUse: (port) => Promise.resolve(portsInUse.has(port)),
    onState: (event) => events.push(event),
    ...(idleMs === undefined ? {} : { idleMs }),
    ...(orchestrator === undefined ? {} : { orchestrator }),
    ...(usage === undefined ? {} : { usage }),
  });
  managers.push(manager);
  return manager;
};

const launch = (
  manager: AgentManager,
  drafts: AgentDraft[],
  counters: Workspace['quickLaunchCounters'] = { freeTerminal: 0 },
) => manager.launch({ workspaceId: workspace.id, agents: drafts, counters });

const agentsOnDisk = async () => (await stores.workspace(workspace.id).read())?.agents ?? [];
const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);

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

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-agents-')));
  repo = join(root, 'Mes Projets', 'Développement');
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
  hookUrl = await hooks.start();
  events = [];
  managers = [];
  scenario = 'prompt-then-done';
  shellEnv = baseEnv;
  portsInUse = new Set();
}, 30_000);

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  // Reads queue behind the last writes: nothing is left writing into the folder removed below.
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe('AgentManager.launch', { timeout: 30_000 }, () => {
  it('gives each agent its position, color, port, branch and worktree', async () => {
    const agents = await launch(await createManager(), [draft(), draft()]);
    expect(
      agents.map(({ position, color, port, branch, worktreePath, baseBranch }) => ({
        position,
        color,
        port,
        branch,
        worktreePath,
        baseBranch,
      })),
    ).toEqual([
      {
        position: 1,
        color: 'purple',
        port: 3001,
        branch: 'agent/fake-1',
        worktreePath: join(repo, '.worktrees', 'fake-1'),
        baseBranch: 'main',
      },
      {
        position: 2,
        color: 'cyan',
        port: 3002,
        branch: 'agent/fake-2',
        worktreePath: join(repo, '.worktrees', 'fake-2'),
        baseBranch: 'main',
      },
    ]);
    const worktrees = git(repo, 'worktree', 'list');
    expect(worktrees).toContain('[agent/fake-1]');
    expect(worktrees).toContain('[agent/fake-2]');
  });

  it('never touches the main branch or the main working tree (FR-039)', async () => {
    const head = git(repo, 'rev-parse', 'main');
    const [agent] = await launch(await createManager(), [draft()]);
    await waitForState(agent?.id ?? '', 'awaiting-prompt');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(git(repo, 'rev-parse', 'main')).toBe(head);
  });

  it('starts every agent of a batch, each one reaching its prompt', async () => {
    const agents = await launch(await createManager(), [draft(), draft(), draft()]);
    for (const agent of agents) await waitForState(agent.id, 'awaiting-prompt');
    const saved = await agentsOnDisk();
    expect(saved.map((a) => a.state)).toEqual([
      'awaiting-prompt',
      'awaiting-prompt',
      'awaiting-prompt',
    ]);
    expect(saved.every((a) => a.sessionId !== null)).toBe(true);
  });

  it('counts the agents whose process runs, for the quit question (T110)', async () => {
    const manager = await createManager();
    expect(manager.activeCount()).toBe(0);
    const agents = await launch(manager, [draft(), draft()]);
    for (const agent of agents) await waitForState(agent.id, 'awaiting-prompt');
    expect(manager.activeCount()).toBe(2);
    await manager.dispose();
    expect(manager.activeCount()).toBe(0);
  });

  it('keeps assigning colors in order across launches', async () => {
    const manager = await createManager();
    await launch(manager, [draft(), draft(), draft()]);
    const [fourth] = await launch(manager, [draft()]);
    expect(fourth).toMatchObject({ position: 4, color: 'magenta', port: 3004 });
  });

  it('uses the next free port beyond the workspace range when 3000 + position is taken', async () => {
    portsInUse.add(3001);
    const [agent] = await launch(await createManager(), [draft()]);
    expect(agent?.port).toBe(3007);
  });

  it('keeps the base branch, branch, port, model and level chosen in the form', async () => {
    git(repo, 'branch', 'develop');
    const [agent] = await launch(await createManager(), [
      draft({
        baseBranch: 'develop',
        branch: 'feature/login',
        port: 4100,
        model: 'fake',
        permissionLevel: 'always-ask',
        startCommand: 'npm run dev',
      }),
    ]);
    expect(agent).toMatchObject({
      baseBranch: 'develop',
      branch: 'feature/login',
      port: 4100,
      model: 'fake',
      permissionLevel: 'always-ask',
      startCommand: 'npm run dev',
    });
    expect(git(join(repo, '.worktrees', 'fake-1'), 'branch', '--show-current')).toBe(
      'feature/login',
    );
  });

  // 004 R5 — without a way to open its MCP access, an agent with a role still starts, without it.
  it('starts an agent with a role and its effort, with no MCP access to give it', async () => {
    const orchestrator = { prepare: vi.fn(), release: vi.fn() };
    for (const manager of [await createManager(), await createManager({ orchestrator })]) {
      const [agent] = await launch(manager, [draft({ role: 'dev', effort: 'high' })]);
      expect(agent).toMatchObject({ role: 'dev', effort: 'high' });
      await waitForState(agent?.id ?? '', 'awaiting-prompt');
      await manager.close(agent?.id ?? '', { removeWorktree: true });
    }
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('remembers the quick-launch counters of the workspace (FR-010)', async () => {
    await launch(await createManager(), [draft()], { freeTerminal: 2, fake: 1 });
    expect(workspaces.get(workspace.id)?.quickLaunchCounters).toEqual({ freeTerminal: 2, fake: 1 });
    expect((await stores.workspace(workspace.id).read())?.quickLaunchCounters).toEqual({
      freeTerminal: 2,
      fake: 1,
    });
  });
});

describe('AgentManager launch validation', { timeout: 30_000 }, () => {
  const noWorktree = () => {
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  };

  it('refuses more than 6 agents in a workspace (LIMIT)', async () => {
    const manager = await createManager();
    await expect(
      launch(
        manager,
        Array.from({ length: 7 }, () => draft()),
      ),
    ).rejects.toMatchObject({
      code: 'LIMIT',
    });
    noWorktree();
    await launch(manager, [draft(), draft()]);
    await expect(
      launch(
        manager,
        Array.from({ length: 5 }, () => draft()),
      ),
    ).rejects.toMatchObject({
      code: 'LIMIT',
    });
  });

  it('refuses a branch used twice, by another agent or already in the repository', async () => {
    const manager = await createManager();
    await expect(
      launch(manager, [draft({ branch: 'feature/a' }), draft({ branch: 'feature/a' })]),
    ).rejects.toMatchObject({ code: 'BRANCH_CONFLICT' });
    await expect(launch(manager, [draft({ branch: 'main' })])).rejects.toMatchObject({
      code: 'BRANCH_CONFLICT',
    });
    noWorktree();
    await launch(manager, [draft()]);
    await expect(launch(manager, [draft({ branch: 'agent/fake-1' })])).rejects.toMatchObject({
      code: 'BRANCH_CONFLICT',
    });
  });

  it('refuses a port used twice, by another agent or by another program', async () => {
    const manager = await createManager();
    await expect(
      launch(manager, [draft({ port: 4000 }), draft({ port: 4000 })]),
    ).rejects.toMatchObject({ code: 'PORT_CONFLICT' });
    portsInUse.add(4001);
    await expect(launch(manager, [draft({ port: 4001 })])).rejects.toMatchObject({
      code: 'PORT_CONFLICT',
    });
    noWorktree();
    await launch(manager, [draft()]);
    await expect(launch(manager, [draft({ port: 3001 })])).rejects.toMatchObject({
      code: 'PORT_CONFLICT',
    });
  });

  it('never gives an automatic port that another agent of the batch chose', async () => {
    const agents = await launch(await createManager(), [draft(), draft({ port: 3001 })]);
    expect(agents.map((a) => a.port)).toEqual([3007, 3001]);
  });

  it('refuses a CLI that is not installed and an unknown workspace', async () => {
    const manager = await createManager();
    await expect(launch(manager, [draft({ cliId: 'codex' })])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      manager.launch({ workspaceId: 'nope', agents: [draft()], counters: { freeTerminal: 0 } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AgentManager terminal and environment', { timeout: 30_000 }, () => {
  it('gives the agent its port, hook URL, token and id, and none of the parent Claude Code session', async () => {
    shellEnv = { ...baseEnv, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP_ME: 'yes' };
    const spawned: PtySpawnOptions[] = [];
    const recording = new PtyManager({
      spawn: (_file, _args, options) => {
        spawned.push(options);
        let exit: (event: { exitCode: number }) => void = () => undefined;
        return {
          onData: () => ({ dispose: () => undefined }),
          onExit: (listener) => {
            exit = listener;
            return { dispose: () => undefined };
          },
          write: () => undefined,
          resize: () => undefined,
          kill: () => {
            exit({ exitCode: 0 });
          },
        };
      },
    });
    const [agent] = await launch(await createManager({ ptyManager: recording }), [draft()]);
    const env = spawned[0]?.env ?? {};
    expect(env).toMatchObject({
      PORT: '3001',
      PACT_PORT: '3001',
      PACT_HOOK_URL: hookUrl,
      PACT_AGENT_ID: agent?.id,
      KEEP_ME: 'yes',
    });
    expect(env.PACT_AGENT_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(spawned[0]?.cwd).toBe(join(repo, '.worktrees', 'fake-1'));
  });

  it('follows starting → awaiting-prompt → working → done and keeps the first prompt', async () => {
    const [agent] = await launch(await createManager(), [draft()]);
    const id = agent?.id ?? '';
    expect(agent?.state).toBe('starting');
    await waitForState(id, 'awaiting-prompt');
    pty.write(id, 'Ajoute un test\r');
    await waitForState(id, 'done');
    expect(events.filter((e) => e.agentId === id).map((e) => e.state)).toEqual([
      'awaiting-prompt',
      'working',
      'done',
    ]);
    expect((await agentsOnDisk())[0]).toMatchObject({
      state: 'done',
      initialPrompt: 'Ajoute un test',
    });
  });

  it('never types a prompt in place of the user (FR-018)', async () => {
    const write = vi.spyOn(pty, 'write');
    const [agent] = await launch(await createManager(), [draft()]);
    await waitForState(agent?.id ?? '', 'awaiting-prompt');
    await new Promise((r) => setTimeout(r, 200));
    expect(write).not.toHaveBeenCalled();
  });

  it('reads dialogs from the terminal output when no hook reports them', async () => {
    scenario = 'ask-permission';
    const adapter = new TerminalDialogFake({ cliPath: FAKE_CLI, platform: process.platform });
    const [agent] = await launch(await createManager({ adapter }), [draft()]);
    const id = agent?.id ?? '';
    await waitForState(id, 'awaiting-prompt');
    pty.write(id, 'Supprime le fichier\r');
    await waitForState(id, 'awaiting-answer');
  });

  it('asks the adapter again once the output has been idle, for CLIs without hooks', async () => {
    scenario = 'ask-permission';
    const adapter = new IdleQuestionFake({ cliPath: FAKE_CLI, platform: process.platform });
    const [agent] = await launch(await createManager({ adapter, idleMs: 150 }), [draft()]);
    const id = agent?.id ?? '';
    await waitForState(id, 'awaiting-prompt');
    // The prompt, idle but no question: asked again, nothing changes.
    const start = Date.now();
    while (!adapter.contexts.some((ctx) => ctx.idleMs === 150) && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(adapter.contexts).toContainEqual({ idleMs: 150 });
    expect(current(id)?.state).toBe('awaiting-prompt');
    pty.write(id, 'Supprime le fichier\r');
    await waitForState(id, 'awaiting-answer');
    expect(current(id)?.state).toBe('awaiting-answer');
  });

  it('shows a crash with the exit code', async () => {
    scenario = 'crash-exit-1';
    const [agent] = await launch(await createManager(), [draft()]);
    const id = agent?.id ?? '';
    await waitForState(id, 'awaiting-prompt');
    pty.write(id, 'Plante\r');
    await waitForState(id, 'error');
    const start = Date.now();
    while (current(id)?.lastError?.code !== 1 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(current(id)?.lastError).toMatchObject({ code: 1, kind: 'crash' });
  });

  it('keeps the rate limit reason when the CLI exits after it', async () => {
    scenario = 'rate-limit';
    const [agent] = await launch(await createManager(), [draft()]);
    const id = agent?.id ?? '';
    await waitForState(id, 'awaiting-prompt');
    pty.write(id, 'Travaille\r');
    await waitForState(id, 'error');
    const start = Date.now();
    while (current(id)?.lastError?.code !== 1 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(current(id)?.lastError).toMatchObject({ code: 1, kind: 'rate-limit' });
  });
});

describe('AgentManager restart of the app (FR-038)', { timeout: 30_000 }, () => {
  it('restores the agents with their colors, branches and ports, to be resumed', async () => {
    const manager = await createManager();
    const launched = await launch(manager, [draft(), draft()]);
    for (const agent of launched) await waitForState(agent.id, 'awaiting-prompt');
    await manager.dispose();
    workspaces.dispose();
    expect((await agentsOnDisk()).map((a) => a.state)).toEqual([
      'awaiting-prompt',
      'awaiting-prompt',
    ]);

    workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
    await workspaces.restore();
    const restarted = await createManager({ ptyManager: new PtyManager() });
    await restarted.restore(workspace.id);

    const restored = workspaces.get(workspace.id)?.agents ?? [];
    const identity = (a: Agent) => [a.id, a.position, a.color, a.branch, a.port, a.worktreePath];
    expect(restored.map(identity)).toEqual(launched.map(identity));
    expect(restored.every((a) => a.sessionId !== null)).toBe(true);
    for (const agent of restored) {
      expect(agent).toMatchObject({ state: 'error', lastError: { code: null, kind: 'crash' } });
      expect(agent.lastError?.message).toMatch(/reprendre/);
    }
    expect((await agentsOnDisk()).map((a) => a.state)).toEqual(['error', 'error']);
  });

  it('keeps a rate limit waiting for its automatic resume', async () => {
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    const id = agent?.id ?? '';
    const scheduledResume = { agentId: id, at: '2030-01-01T09:30:00.000Z', attempt: 0 };
    await manager.dispose();
    await workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => ({
        ...a,
        state: 'error' as const,
        lastError: { code: 1, kind: 'rate-limit' as const, message: 'Limite atteinte' },
        scheduledResume,
      })),
    }));
    await (await createManager({ ptyManager: new PtyManager() })).restore(workspace.id);
    expect(current(id)).toMatchObject({
      state: 'error',
      lastError: { kind: 'rate-limit', message: 'Limite atteinte' },
      scheduledResume,
    });
  });

  it('restores nothing for a workspace that is not open', async () => {
    await expect((await createManager()).restore('unknown')).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('stops the agents without recording their exit as a crash', async () => {
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    const id = agent?.id ?? '';
    await waitForState(id, 'awaiting-prompt');
    await manager.dispose();
    expect(pty.has(id)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(current(id)?.state).toBe('awaiting-prompt');
  });
});

describe('AgentManager launch of an orchestrator without a way to serve one', () => {
  it('refuses an orchestrator draft, and saves no agent', async () => {
    const manager = await createManager();
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Orchestrateur indisponible.',
    });
    expect(workspaces.get(workspace.id)?.agents).toEqual([]);
  });
});

// #113 — a launch that fails before the CLI starts must not leave a ghost holding the role.
describe('AgentManager launch of an orchestrator whose access cannot be prepared', () => {
  const failing = () => ({
    prepare: vi.fn().mockRejectedValue(new Error('ENOENT: resources/skills/pact-orchestrator')),
    release: vi.fn(),
  });

  it('rejects, and leaves no agent, so no ghost orchestrator', async () => {
    const manager = await createManager({ orchestrator: failing() });
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toThrow(/ENOENT/);
    expect(workspaces.get(workspace.id)?.agents).toEqual([]);
    expect(await agentsOnDisk()).toEqual([]);
    expect(manager.activeCount()).toBe(0);
  });

  it('frees the worktree and the position, so a launch can be tried again', async () => {
    const orchestrator = failing();
    const manager = await createManager({ orchestrator });
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toThrow();
    expect(git(repo, 'worktree', 'list')).not.toContain('fake-1');
    expect(git(repo, 'branch', '--list', 'agent/*')).toBe('');
    orchestrator.prepare.mockRejectedValueOnce(new Error('ENOENT again'));
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toThrow(/again/);
    expect(workspaces.get(workspace.id)?.agents).toEqual([]);
  });
});

// #113 — the cleanup of a failed launch never hides the error that failed it.
describe('AgentManager abandon of a failed launch', () => {
  const failing = () => ({
    prepare: vi.fn().mockRejectedValue(new Error('ENOENT original')),
    release: vi.fn(),
  });

  it('throws the original error when saving the workspace fails too, and still frees the branch', async () => {
    const manager = await createManager({ orchestrator: failing() });
    const update = workspaces.update.bind(workspaces);
    let calls = 0;
    vi.spyOn(workspaces, 'update').mockImplementation((id, fn) => {
      calls += 1;
      // 1st: the agent is saved; 2nd: the cleanup fails.
      return calls === 2 ? Promise.reject(new Error('disk full')) : update(id, fn);
    });
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toThrow(
      /ENOENT original/,
    );
    expect(git(repo, 'branch', '--list', 'agent/*')).toBe('');
    expect(git(repo, 'worktree', 'list')).not.toContain('fake-1');
  });

  it('throws the original error when the worktree cannot be removed', async () => {
    class Stuck extends GitService {
      override removeWorktree = () => Promise.reject(new Error('locked'));
    }
    const manager = await createManager({
      orchestrator: failing(),
      gitService: new Stuck({ env: gitEnv }),
    });
    await expect(launch(manager, [draft({ role: 'orchestrator' })])).rejects.toThrow(
      /ENOENT original/,
    );
    expect(workspaces.get(workspace.id)?.agents).toEqual([]);
  });
});

// fix-todo-diff-notifications — a new worktree starts from origin/<main>, after a try to fetch it.
describe('AgentManager.launch from origin', { timeout: 30_000 }, () => {
  let origin: string;
  let other: string;

  beforeEach(() => {
    origin = join(root, 'origin.git');
    other = join(root, 'other');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
    git(root, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'lag.txt'), 'lag\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'lag');
    git(other, 'push', '-q', 'origin', 'main');
  });

  it('starts from the fetched origin/main, the local main lagging behind', async () => {
    const [agent] = await launch(await createManager(), [draft()]);
    const remote = git(other, 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'main')).not.toBe(remote);
    expect(git(agent?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(remote);
    // The local main is not moved.
    expect(git(repo, 'rev-parse', 'main')).not.toBe(remote);
  });

  it('starts from the last origin/main known when the fetch fails', async () => {
    git(repo, 'fetch', '-q', 'origin', 'main');
    const known = git(repo, 'rev-parse', 'origin/main');
    expect(known).not.toBe(git(repo, 'rev-parse', 'main'));
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    const [agent] = await launch(await createManager(), [draft()]);
    expect(git(agent?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(known);
  });

  it('respects an explicit baseBranch', async () => {
    git(repo, 'branch', 'develop');
    writeFileSync(join(repo, 'dev.txt'), 'dev\n');
    git(repo, 'checkout', '-q', 'develop');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'develop work');
    git(repo, 'checkout', '-q', 'main');
    const [agent] = await launch(await createManager(), [draft({ baseBranch: 'develop' })]);
    expect(git(agent?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(
      git(repo, 'rev-parse', 'develop'),
    );
  });

  // A remote that does not answer must not hold a launch: it waits a short time, then starts
  // from the last origin/main known. The fetch itself is never really waited for.
  it('starts from the last origin/main known when the fetch does not answer in time', async () => {
    git(repo, 'fetch', '-q', 'origin', 'main');
    const known = git(repo, 'rev-parse', 'origin/main');
    class Silent extends GitService {
      override fetchOrigin = () => new Promise<boolean>(() => undefined);
    }
    const manager = await createManager({
      gitService: new Silent({ env: gitEnv }),
      fetchTimeoutMs: 20,
    });
    const [agent] = await launch(manager, [draft()]);
    expect(git(agent?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(known);
  });

  it('waits once for a silent remote whatever the number of agents', async () => {
    git(repo, 'fetch', '-q', 'origin', 'main');
    const known = git(repo, 'rev-parse', 'origin/main');
    const fetches: string[] = [];
    class Silent extends GitService {
      override fetchOrigin = (_cwd: string, branch: string) => {
        fetches.push(branch);
        return new Promise<boolean>(() => undefined);
      };
    }
    const manager = await createManager({
      gitService: new Silent({ env: gitEnv }),
      fetchTimeoutMs: 150,
    });
    const agents = await launch(manager, [draft(), draft(), draft()]);
    // One fetch, so one wait: a wait per agent would have asked three times.
    expect(fetches).toHaveLength(1);
    for (const agent of agents) {
      expect(git(agent.worktreePath, 'rev-parse', 'HEAD')).toBe(known);
    }
  });
});

// 007 T008 — the result of the fetch is kept and read once by launch_agent (FR-022, research R13,
// US4 sc.5 to 7). `launchWarnings(agentId)` gives the warnings of the launch of an agent, once.
describe('AgentManager.launchWarnings', { timeout: 30_000 }, () => {
  let origin: string;

  beforeEach(() => {
    origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'fetch', '-q', 'origin');
  });

  const warnings = (manager: AgentManager, id: string) =>
    (manager as unknown as { launchWarnings(id: string): string[] }).launchWarnings(id);

  it('warns when the fetch fails: the agent starts from the last origin/main known', async () => {
    const known = git(repo, 'rev-parse', 'origin/main');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    expect(git(agent?.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(known);
    const first = warnings(manager, agent?.id ?? '');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/fetch|origin/i);
  });

  it('warns when the fetch does not answer in time', async () => {
    class Silent extends GitService {
      override fetchOrigin = () => new Promise<boolean>(() => undefined);
    }
    const manager = await createManager({
      gitService: new Silent({ env: gitEnv }),
      fetchTimeoutMs: 20,
    });
    const [agent] = await launch(manager, [draft()]);
    expect(warnings(manager, agent?.id ?? '')).toHaveLength(1);
  });

  it('gives the warning once: a second reading is empty', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    expect(warnings(manager, agent?.id ?? '')).toHaveLength(1);
    expect(warnings(manager, agent?.id ?? '')).toEqual([]);
  });

  it('warns for every agent of a launch whose fetch failed', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    const manager = await createManager();
    const agents = await launch(manager, [draft(), draft()]);
    for (const agent of agents) expect(warnings(manager, agent.id)).toHaveLength(1);
  });

  it('does not warn when the fetch succeeds', async () => {
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    expect(warnings(manager, agent?.id ?? '')).toEqual([]);
  });

  it('does not warn when the repository has no remote', async () => {
    git(repo, 'remote', 'remove', 'origin');
    const manager = await createManager();
    const [agent] = await launch(manager, [draft()]);
    expect(warnings(manager, agent?.id ?? '')).toEqual([]);
  });

  it('does not warn for an explicit baseBranch, whatever the remote: no fetch is expected', async () => {
    git(repo, 'branch', 'develop');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    const manager = await createManager();
    const [agent] = await launch(manager, [draft({ baseBranch: 'develop' })]);
    expect(warnings(manager, agent?.id ?? '')).toEqual([]);
  });
});

// 009 T008 — a paused agent survives a restart of PACT, and the agents of an account are found in every
// workspace (research R7, R9; FR-006, FR-011, US2 sc.4).

describe(
  'AgentManager restart of the app with a paused agent (FR-006)',
  { timeout: 30_000 },
  () => {
    const pause = {
      cliId: 'fake',
      account: 'default',
      cause: 'threshold',
      windows: [
        { id: 'five-hour', label: '5 h', percent: 91, resetsAt: '2030-01-01T09:30:00.000Z' },
      ],
      resumeAt: '2030-01-01T09:30:00.000Z',
      pausedAt: '2029-12-31T23:00:00.000Z',
      midTurn: true,
      saved: false,
      closedQuestion: null,
      blocked: null,
    };

    it('leaves a paused agent paused, not « à reprendre », with its pause and its resume', async () => {
      const manager = await createManager();
      const [agent] = await launch(manager, [draft()]);
      const id = agent?.id ?? '';
      await waitForState(id, 'awaiting-prompt');
      await manager.dispose();
      const scheduledResume = { agentId: id, at: '2030-01-01T09:30:00.000Z', attempt: 0 };
      await workspaces.update(workspace.id, (ws) => ({
        ...ws,
        agents: ws.agents.map((a) => ({ ...a, state: 'paused', pause, scheduledResume }) as never),
      }));

      workspaces.dispose();
      workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
      await workspaces.restore();
      const restarted = await createManager({ ptyManager: new PtyManager() });
      await restarted.restore(workspace.id);

      expect(current(id)).toMatchObject({
        state: 'paused',
        lastError: null,
        pause,
        scheduledResume,
      });
      expect((await agentsOnDisk())[0]).toMatchObject({ state: 'paused', lastError: null });
      expect(events.filter((e) => e.agentId === id).map((e) => e.state)).not.toContain('error');
    });
  },
);

describe('AgentManager.accountAgents', { timeout: 40_000 }, () => {
  const spyUsage = () => ({ statusLine: vi.fn(() => 'PACT'), follow: vi.fn(), release: vi.fn() });
  type Accounted = { accountAgents(cliId: string, account: string): { id: string }[] };
  const ids = (manager: AgentManager, account = 'default') =>
    (manager as unknown as Accounted).accountAgents('fake', account).map((a) => a.id);

  const secondWorkspace = async () => {
    const other = join(root, 'Autre dépôt');
    await mkdir(other, { recursive: true });
    git(other, 'init', '-b', 'main');
    await writeFile(join(other, 'README.md'), '# autre\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'initial');
    return workspaces.open(other);
  };
  const launchIn = async (manager: AgentManager, workspaceId: string) => {
    const [agent] = await manager.launch({
      workspaceId,
      agents: [draft()],
      counters: { freeTerminal: 0 },
    });
    return agent?.id ?? '';
  };
  const waitUntil = async (check: () => boolean, what: string) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > 10_000) throw new Error(what);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('gives the agents of the account in every open workspace, and none of another account', async () => {
    const manager = await createManager({ usage: spyUsage() });
    const first = await launchIn(manager, workspace.id);
    const other = await secondWorkspace();
    const second = await launchIn(manager, other.id);
    shellEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: '/comptes/travail' };
    const elsewhere = await launchIn(manager, workspace.id);

    expect(ids(manager).sort()).toEqual([first, second].sort());
    expect(ids(manager, '/comptes/travail')).toEqual([elsewhere]);
    expect(ids(manager, '/comptes/inconnu')).toEqual([]);
  });

  it('leaves out an agent that is closed', async () => {
    const manager = await createManager({ usage: spyUsage() });
    const kept = await launchIn(manager, workspace.id);
    const closed = await launchIn(manager, workspace.id);
    await manager.close(closed, { removeWorktree: false });
    expect(ids(manager)).toEqual([kept]);
  });

  it('keeps an agent in a rate limit error, whose process has ended (R7)', async () => {
    scenario = 'rate-limit';
    const manager = await createManager({ usage: spyUsage() });
    const id = await launchIn(manager, workspace.id);
    await waitForState(id, 'awaiting-prompt');
    pty.write(id, 'Travaille\r');
    await waitForState(id, 'error');
    await waitUntil(() => !pty.has(id), 'the process never ended');
    expect(current(id)?.lastError?.kind).toBe('rate-limit');
    expect(ids(manager)).toEqual([id]);
  });

  it('gives no agent of a CLI that reports no usage (FR-011)', async () => {
    const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
    Object.defineProperty(adapter, 'usageSource', { value: undefined });
    const manager = await createManager({ adapter, usage: spyUsage() });
    await launchIn(manager, workspace.id);
    expect(ids(manager)).toEqual([]);
  });

  it('gives no agent when no usage service is there (FR-011)', async () => {
    const manager = await createManager();
    await launchIn(manager, workspace.id);
    expect(ids(manager)).toEqual([]);
  });
});
