import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
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
import type { AgentDraft } from '../../../src/shared/ipc';
import type { Agent, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// 009 T032 — what the manager itself does for a paused agent: the pieces the usage service calls
// (`pausedAgents`, `resumePaused`, `schedule`), the hand-over of « Reprendre » and of a due resume.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const INFO = {
  cliId: 'fake',
  account: 'default',
  cause: 'threshold' as const,
  windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: null }],
  resumeAt: null,
  pausedAt: '2030-01-01T09:00:00.000Z',
};

let root: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let hookUrl: string;
let events: AgentStateEvent[];
let managers: AgentManager[];

const build = async (extra: Record<string, unknown> = {}) => {
  const registry = new CliRegistry({
    adapters: [new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform })],
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
    resolveEnv: () =>
      Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done') }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    autoResume: () => Promise.resolve(true),
    usage: { statusLine: () => 'PACT', follow: () => undefined, release: () => undefined },
    ...extra,
  });
  managers.push(manager);
  return manager;
};

/** `resumeDue` is private: the timer of the manager calls it, and so does this test. */
const dueOf = (manager: AgentManager) => {
  const target = manager as unknown as { resumeDue(resume: unknown): Promise<void> };
  return (resume: unknown) => target.resumeDue(resume);
};

const draft = (): AgentDraft => ({
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
});
const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);
const waitFor = async (id: string, state: Agent['state']) => {
  const start = Date.now();
  while (
    current(id)?.state !== state ||
    events.findLast((e) => e.agentId === id)?.state !== state
  ) {
    if (Date.now() - start > 10_000) throw new Error(`${id} stayed ${String(current(id)?.state)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const launched = async (manager: AgentManager) => {
  const [agent] = await manager.launch({
    workspaceId: workspace.id,
    agents: [draft()],
    counters: { freeTerminal: 0 },
  });
  if (!agent) throw new Error('no agent');
  await waitFor(agent.id, 'awaiting-prompt');
  await workspaces.update(workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => (a.id === agent.id ? { ...a, sessionId: 'session-m' } : a)),
  }));
  return agent;
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-resume-mgr-')));
  const repo = join(root, 'Dépôt');
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
}, 30_000);

afterEach(async () => {
  for (const manager of managers) await manager.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe('the manager and the agents in pause (009 T032)', { timeout: 40_000 }, () => {
  it('Given agents of two accounts, When asked, Then only the paused ones of that account are listed', async () => {
    const manager = await build();
    const mine = await launched(manager);
    expect(manager.pausedAgents('fake', 'default')).toEqual([]);
    await manager.pause(mine.id, INFO);
    expect(manager.pausedAgents('fake', 'default').map((a) => a.id)).toEqual([mine.id]);
    expect(manager.pausedAgents('fake', 'other')).toEqual([]);
    expect(manager.pausedAgents('codex', 'default')).toEqual([]);
  });

  it('Given a paused agent, When it is paused again, Then nothing changes', async () => {
    const manager = await build();
    const first = await launched(manager);
    await manager.pause(first.id, INFO);
    const seen = events.length;
    await manager.pause(first.id, { ...INFO, account: 'elsewhere' });
    expect(events).toHaveLength(seen);
    expect(current(first.id)?.pause?.account).toBe('default');
  });

  it('Given an agent that is not paused, When it is resumed as a paused one, Then the manager refuses', async () => {
    const manager = await build();
    const agent = await launched(manager);
    await expect(manager.resumePaused(agent.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('Given a paused agent, When a resume is scheduled then cleared, Then the agent carries it, then no longer', async () => {
    const manager = await build();
    const agent = await launched(manager);
    await manager.pause(agent.id, INFO);
    await manager.schedule(agent.id, null);
    expect(current(agent.id)?.scheduledResume).toBeNull();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    await manager.schedule(agent.id, { agentId: agent.id, at, attempt: 0 });
    expect(current(agent.id)?.scheduledResume).toEqual({ agentId: agent.id, at, attempt: 0 });
    await manager.schedule(agent.id, null);
    expect(current(agent.id)?.scheduledResume).toBeNull();
    expect(current(agent.id)?.state).toBe('paused');
  });

  it('Given a service to hand over to, When the user resumes a paused agent from its tile, Then the service gets the agent and the manager starts nothing itself', async () => {
    const onPausedResume = vi.fn(() => Promise.resolve());
    const manager = await build({ onPausedResume });
    const agent = await launched(manager);
    await manager.pause(agent.id, INFO);
    await manager.resume(agent.id);
    expect(onPausedResume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: agent.id }),
    );
    expect(current(agent.id)?.state).toBe('paused');
  });

  it('Given a resume that is no longer the scheduled one, When it falls due, Then the paused agent is left alone', async () => {
    const onPausedDue = vi.fn();
    const manager = await build({ onPausedDue });
    const agent = await launched(manager);
    await manager.pause(agent.id, INFO);
    const due = dueOf(manager);
    await due({ agentId: agent.id, at: '2000-01-01T00:00:00.000Z', attempt: 7 });
    expect(onPausedDue).not.toHaveBeenCalled();
    const scheduled = current(agent.id)?.scheduledResume;
    await due(scheduled);
    expect(onPausedDue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: agent.id }));
  });

  it('Given an unknown agent, When a resume falls due for it, Then nothing happens', async () => {
    const onPausedDue = vi.fn();
    const manager = await build({ onPausedDue });
    await dueOf(manager)({ agentId: 'nobody', at: '2000-01-01T00:00:00.000Z', attempt: 0 });
    expect(onPausedDue).not.toHaveBeenCalled();
  });
});
