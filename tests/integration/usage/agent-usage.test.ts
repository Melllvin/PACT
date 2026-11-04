import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import type { UsageSource } from '../../../src/main/usage/usage-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// 005 R1–R3 — the usage source of an agent: the statusLine of its account (Claude Code) and the
// rollout of its session (Codex), followed once the session starts.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

type Usage = {
  statusLine: ReturnType<typeof vi.fn<(source: UsageSource, payload: unknown) => string>>;
  follow: ReturnType<
    typeof vi.fn<(source: UsageSource, rollout: { codexHome: string; sessionId: string }) => void>
  >;
  release: ReturnType<typeof vi.fn<(agentId: string) => void>>;
};

let root: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let manager: AgentManager | undefined;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-usage-')));
  const repo = join(root, 'Développement');
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
}, 30_000);

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await pty.dispose();
  await hooks.stop();
  workspaces.dispose();
  await stores.workspace(workspace.id).read();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

/** A manager over the fake CLI; `codex` makes it report like Codex, through its rollout. */
async function start({
  usage,
  codex = false,
  env = {},
}: {
  usage?: Usage;
  codex?: boolean;
  env?: Record<string, string>;
}) {
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  if (codex) Object.defineProperty(adapter, 'usageSource', { value: 'codex-rollout' });
  const registry = new CliRegistry({
    adapters: [adapter],
    resolveEnv: () => Promise.resolve({}),
    stores,
  });
  await registry.detect();
  const hookUrl = await hooks.start();
  manager = new AgentManager({
    workspaces,
    registry,
    git: new GitService({ env: gitEnv }),
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: () =>
      Promise.resolve({ ...gitEnv, ...env, FAKE_CLI_SCENARIO: scenarioPath('echo-prompt') }),
    isPortInUse: () => Promise.resolve(false),
    ...(usage ? { usage } : {}),
  });
  return manager;
}

const usageSpy = (): Usage => ({
  statusLine: vi.fn(() => 'PACT · 5 h 62 %'),
  follow: vi.fn(),
  release: vi.fn(),
});

async function launchOne(agents: AgentManager) {
  const [agent] = await agents.launch({
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
  return agent;
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  if (!check()) throw new Error(what);
};

describe('the usage source of an agent', { timeout: 30_000 }, () => {
  it('answers the statusLine of a Claude Code agent with its account, and releases it', async () => {
    const usage = usageSpy();
    const register = vi.spyOn(hooks, 'register');
    const agents = await start({ usage, env: { CLAUDE_CONFIG_DIR: '/comptes/travail' } });
    const agent = await launchOne(agents);
    const statusLine = register.mock.calls.at(-1)?.[2];
    expect(statusLine?.({ rate_limits: {} })).toBe('PACT · 5 h 62 %');
    expect(usage.statusLine).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.id,
        workspaceId: workspace.id,
        cliId: 'fake',
        account: '/comptes/travail',
      }),
      { rate_limits: {} },
    );
    expect(usage.follow).not.toHaveBeenCalled();
    await agents.close(agent.id, { removeWorktree: false });
    await until(() => usage.release.mock.calls.length > 0, 'the usage was never released');
    expect(usage.release).toHaveBeenCalledWith(agent.id);
  });

  it('answers « PACT » when no usage service is there', async () => {
    const register = vi.spyOn(hooks, 'register');
    const agents = await start({});
    await launchOne(agents);
    expect(register.mock.calls.at(-1)?.[2]?.({})).toBe('PACT');
  });

  it('follows the rollout of a Codex session once it starts, under CODEX_HOME', async () => {
    const usage = usageSpy();
    const register = vi.spyOn(hooks, 'register');
    const codexHome = join(root, 'codex');
    const agents = await start({ usage, codex: true, env: { CODEX_HOME: codexHome } });
    const agent = await launchOne(agents);
    // Codex reports through its rollout, never through a statusLine.
    expect(register.mock.calls.at(-1)?.[2]).toBeUndefined();
    await until(() => usage.follow.mock.calls.length > 0, 'the rollout was never followed');
    expect(usage.follow).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: agent.id, account: codexHome }),
      { codexHome, sessionId: expect.any(String) as string },
    );
  });

  it('looks for the rollout under ~/.codex without CODEX_HOME', async () => {
    const usage = usageSpy();
    const agents = await start({ usage, codex: true, env: { CODEX_HOME: '', HOME: root } });
    await launchOne(agents);
    await until(() => usage.follow.mock.calls.length > 0, 'the rollout was never followed');
    expect(usage.follow.mock.calls[0]?.[1].codexHome).toBe(join(root, '.codex'));
    expect(usage.follow.mock.calls[0]?.[0].account).toBe('default');
  });
});
