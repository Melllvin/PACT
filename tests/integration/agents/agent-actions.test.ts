import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { IpcEvent } from '../../../src/shared/ipc';
import type { AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// US3 — tile actions on agents run by the fake CLI (T072, FR-024, FR-037).

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

const waitForOutput = (id: string, text: string) =>
  waitFor(() => pty.history(id).includes(text), `« ${text} » never printed`, id);

/** Types a prompt and waits for the crash of `crash-exit-1`, exit code included. */
const crash = async (id: string, prompt = 'Plante') => {
  pty.write(id, `${prompt}\r`);
  await waitForState(id, 'error');
  await waitFor(() => current(id)?.lastError?.code === 1, 'no exit code', id);
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-actions-')));
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
  await rm(root, { recursive: true, force: true });
}, 30_000);

describe('AgentManager.answer', { timeout: 30_000 }, () => {
  it('types the answer keys and the turn goes on', async () => {
    scenario = 'ask-permission';
    const agent = await launchOne();
    pty.write(agent.id, 'Supprime le fichier\r');
    await waitForState(agent.id, 'awaiting-answer');
    const keys = vi.spyOn(adapter, 'answerKeys');
    await manager.answer(agent.id, 'allow');
    expect(keys).toHaveBeenCalledWith('allow');
    await waitForOutput(agent.id, 'Autorisé');
    await waitForState(agent.id, 'done');
  });

  it('only answers an agent that is waiting for an answer', async () => {
    const agent = await launchOne();
    await expect(manager.answer(agent.id, 'deny')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(manager.answer('unknown', 'deny')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AgentManager after a crash', { timeout: 30_000 }, () => {
  it('records the exit code of a crash', async () => {
    scenario = 'crash-exit-1';
    const agent = await launchOne();
    await crash(agent.id);
    expect(current(agent.id)?.lastError).toMatchObject({ code: 1, kind: 'crash' });
  });

  it('« Reprendre » starts the same session again', async () => {
    scenario = 'crash-exit-1';
    const agent = await launchOne();
    const sessionId = current(agent.id)?.sessionId;
    expect(sessionId).toBeTruthy();
    await crash(agent.id);
    const resume = vi.spyOn(adapter, 'buildResume');
    await manager.resume(agent.id);
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    await waitForOutput(agent.id, `Session reprise ${String(sessionId)}`);
    await waitForState(agent.id, 'awaiting-prompt');
    expect(current(agent.id)).toMatchObject({ sessionId, lastError: null });
  });

  it('« Relancer » starts a new session and types the initial prompt again', async () => {
    scenario = 'crash-exit-1';
    const agent = await launchOne();
    const first = current(agent.id)?.sessionId;
    await crash(agent.id, 'Consigne initiale');
    const launchSpy = vi.spyOn(adapter, 'buildLaunch');
    scenario = 'prompt-then-done';
    await manager.restart(agent.id);
    expect(launchSpy).toHaveBeenCalled();
    await waitForState(agent.id, 'done');
    expect(current(agent.id)?.sessionId).not.toBe(first);
    expect(current(agent.id)?.initialPrompt).toBe('Consigne initiale');
    expect(pty.history(agent.id)).toContain('Terminé');
  });

  it('refuses to resume or restart an agent that is not in error', async () => {
    const agent = await launchOne();
    await expect(manager.resume(agent.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(manager.restart(agent.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('« Journal » returns the whole output kept for the agent', async () => {
    scenario = 'crash-exit-1';
    const agent = await launchOne();
    await crash(agent.id);
    expect(manager.log(agent.id)).toContain('Erreur simulée');
  });
});

describe('AgentManager branch watching', { timeout: 30_000 }, () => {
  it('announces a branch renamed by the agent and saves it', async () => {
    scenario = 'rename-branch';
    const agent = await launchOne();
    pty.write(agent.id, 'Renomme\r');
    await waitFor(() => branches.length > 0, 'no agent:branch event', agent.id);
    expect(branches).toEqual([{ agentId: agent.id, branch: 'feature/login' }]);
    expect(current(agent.id)?.branch).toBe('feature/login');
  });
});

describe('AgentManager.close (FR-037)', { timeout: 30_000 }, () => {
  it('stops the agent and keeps its worktree and branch', async () => {
    const agent = await launchOne();
    await manager.close(agent.id, { removeWorktree: false });
    expect(pty.has(agent.id)).toBe(false);
    expect(current(agent.id)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ agentId: agent.id, state: 'closed' });
    expect(existsSync(agent.worktreePath)).toBe(true);
    expect(git(repo, 'branch', '--list', agent.branch)).not.toBe('');
    await new Promise((r) => setTimeout(r, 100));
    expect(events.at(-1)?.state).toBe('closed');
  });

  it('removes the worktree and its branch when asked, even with uncommitted work', async () => {
    const agent = await launchOne();
    await writeFile(join(agent.worktreePath, 'brouillon.txt'), 'en cours\n');
    await manager.close(agent.id, { removeWorktree: true });
    expect(existsSync(agent.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', agent.branch)).toBe('');
    expect((await stores.workspace(workspace.id).read())?.agents).toEqual([]);
  });

  it('closes an agent whose process already stopped', async () => {
    scenario = 'crash-exit-1';
    const agent = await launchOne();
    await crash(agent.id);
    await manager.close(agent.id, { removeWorktree: true });
    expect(current(agent.id)).toBeUndefined();
  });
});
