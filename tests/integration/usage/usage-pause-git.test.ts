import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// 009 R6 — a worktree whose state cannot be read is not known to be clean: `pause.saved` is false,
// whether Git fails or the manager was given no way to ask.

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
let workspace: Workspace;
let workspaces: WorkspaceService;
let pty: PtyManager;
let hooks: HookServer;
let hookUrl: string;
let manager: AgentManager | undefined;
let registry: CliRegistry;

const info = {
  cliId: 'fake',
  account: 'default',
  cause: 'threshold' as const,
  windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: null }],
  resumeAt: null,
  pausedAt: '2030-01-01T09:00:00.000Z',
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-pause-git-')));
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  const stores = openStores(join(root, 'userData'));
  workspaces = new WorkspaceService({ git: new GitService({ env: gitEnv }), stores });
  workspace = await workspaces.open(repo);
  pty = new PtyManager();
  hooks = new HookServer();
  hookUrl = await hooks.start();
  registry = new CliRegistry({
    adapters: [new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform })],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  manager = undefined;
}, 30_000);

afterEach(async () => {
  await manager?.dispose();
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

const pausedWith = async (git2: object) => {
  manager = new AgentManager({
    workspaces,
    registry,
    git: git2 as GitService,
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () =>
      Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioPath('prompt-then-done') }),
    isPortInUse: () => Promise.resolve(false),
    usage: { statusLine: () => 'PACT', follow: () => undefined, release: () => undefined },
  });
  const [started] = await manager.launch({
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
  const id = started?.id ?? '';
  const start = Date.now();
  while (
    workspaces.get(workspace.id)?.agents.find((a) => a.id === id)?.state !== 'awaiting-prompt'
  ) {
    if (Date.now() - start > 10_000) throw new Error('the agent never got ready');
    await new Promise((r) => setTimeout(r, 20));
  }
  await manager.pause(id, info);
  return workspaces.get(workspace.id)?.agents.find((a) => a.id === id);
};

describe('AgentManager.pause with a worktree it cannot read', () => {
  it('Given Git failing, When the agent is paused, Then it is not saved', async () => {
    const real = new GitService({ env: gitEnv });
    const failing = Object.create(real, {
      hasUncommittedChanges: { value: () => Promise.reject(new Error('git a échoué')) },
    }) as object;
    expect((await pausedWith(failing))?.pause?.saved).toBe(false);
  }, 30_000);

  it('Given a manager that cannot ask Git, When the agent is paused, Then it is not saved', async () => {
    const real = new GitService({ env: gitEnv });
    const blind = Object.create(real, { hasUncommittedChanges: { value: undefined } }) as object;
    expect((await pausedWith(blind))?.pause?.saved).toBe(false);
  }, 30_000);
});
