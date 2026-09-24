import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import type { AgentSignal } from '../../../src/main/agents/adapters/types';
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
  override mapOutput(chunk: string): AgentSignal | null {
    const match = /\? Exécuter : (.+) \(allow\/deny\)/.exec(chunk);
    return match?.[1] ? { type: 'awaiting-answer', summary: match[1] } : null;
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
    git: new GitService({ env: gitEnv }),
    pty: ptyManager,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () => Promise.resolve({ ...shellEnv, FAKE_CLI_SCENARIO: scenarioPath(scenario) }),
    isPortInUse: (port) => Promise.resolve(portsInUse.has(port)),
    onState: (event) => events.push(event),
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
});

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  // Reads queue behind the last writes: nothing is left writing into the folder removed below.
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true });
});

describe('AgentManager.launch', () => {
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

  it('remembers the quick-launch counters of the workspace (FR-010)', async () => {
    await launch(await createManager(), [draft()], { freeTerminal: 2, fake: 1 });
    expect(workspaces.get(workspace.id)?.quickLaunchCounters).toEqual({ freeTerminal: 2, fake: 1 });
    expect((await stores.workspace(workspace.id).read())?.quickLaunchCounters).toEqual({
      freeTerminal: 2,
      fake: 1,
    });
  });
});

describe('AgentManager launch validation', () => {
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

describe('AgentManager terminal and environment', () => {
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

describe('AgentManager restart of the app (FR-038)', () => {
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
