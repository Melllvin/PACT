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
import type { IpcEvent } from '../../../src/shared/ipc';
import type { AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// US5 — « Toujours pour ce worktree » (T088, FR-034, research.md R4): the rule is kept on the
// agent and later requests with the same ruleKey are allowed without asking the user again.

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

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-always-')));
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

const RULE = 'Bash(rm fichier.txt)';

/** `ask-permission` asks for the same command once per turn. */
const askedTimes = (id: string) => pty.history(id).split('? Exécuter').length - 1;
const allowedTimes = (id: string) => pty.history(id).split('Autorisé').length - 1;

/** Types a prompt, answers its request and waits for the end of the turn. */
const firstTurn = async (id: string, always: boolean) => {
  pty.write(id, 'Supprime le fichier\r');
  await waitForState(id, 'awaiting-answer');
  await manager.answer(id, 'allow', always);
  // The Stop hook may come before the terminal output (ConPTY on Windows).
  await waitFor(() => allowedTimes(id) === 1, 'request not allowed', id);
  await waitForState(id, 'done');
};

/** A second turn asks for the same command again. */
const secondTurn = (id: string) => {
  events.length = 0;
  pty.write(id, 'Encore\r');
};

/** Answers the way Claude Code expects from its PermissionRequest hook (R4). */
class DecidingAdapter extends FakeAdapter {
  permissionDecision(behavior: 'allow') {
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } };
  }
}

describe('« Toujours pour ce worktree »', { timeout: 30_000 }, () => {
  beforeEach(() => {
    scenario = 'ask-permission';
  });

  it('allows the current request and keeps its rule on the agent', async () => {
    const agent = await launchOne();
    await firstTurn(agent.id, true);
    expect(allowedTimes(agent.id)).toBe(1);
    expect(current(agent.id)?.alwaysAllowRules).toEqual([RULE]);
  });

  it('types the allow keys for a later request with the same rule, without asking', async () => {
    const agent = await launchOne();
    await firstTurn(agent.id, true);
    const keys = vi.spyOn(adapter, 'answerKeys');
    secondTurn(agent.id);
    await waitFor(() => allowedTimes(agent.id) === 2, 'second request not allowed', agent.id);
    await waitForState(agent.id, 'done');
    expect(keys).toHaveBeenCalledWith('allow');
    expect(askedTimes(agent.id)).toBe(2);
    expect(events.map((e) => e.state)).not.toContain('awaiting-answer');
  });

  it('answers the hook itself when the CLI accepts a decision (Claude Code)', async () => {
    await manager.dispose();
    await hooks.stop();
    adapter = new DecidingAdapter({ cliPath: FAKE_CLI, platform: process.platform });
    manager = await createManager();
    const agent = await launchOne();
    await firstTurn(agent.id, true);
    const write = vi.spyOn(pty, 'write');
    secondTurn(agent.id);
    await waitFor(() => allowedTimes(agent.id) === 2, 'second request not allowed', agent.id);
    await waitForState(agent.id, 'done');
    expect(write).toHaveBeenCalledTimes(1); // « Encore » only: no answer keys typed
    expect(events.map((e) => e.state)).not.toContain('awaiting-answer');
  });

  it('keeps asking when the answer was not « always »', async () => {
    const agent = await launchOne();
    await firstTurn(agent.id, false);
    expect(current(agent.id)?.alwaysAllowRules).toEqual([]);
    secondTurn(agent.id);
    await waitForState(agent.id, 'awaiting-answer');
  });

  it('adds no rule on a refusal', async () => {
    const agent = await launchOne();
    pty.write(agent.id, 'Supprime le fichier\r');
    await waitForState(agent.id, 'awaiting-answer');
    await manager.answer(agent.id, 'deny', true);
    await waitForOutput(agent.id, 'Refusé');
    expect(current(agent.id)?.alwaysAllowRules).toEqual([]);
  });

  it('forgets the rules with the agent when it is closed', async () => {
    const agent = await launchOne();
    await firstTurn(agent.id, true);
    await manager.close(agent.id, { removeWorktree: true });
    const [next] = await manager.launch({
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
    expect(current(next?.id ?? '')?.alwaysAllowRules).toEqual([]);
    expect(workspaces.get(workspace.id)?.agents.flatMap((a) => a.alwaysAllowRules)).toEqual([]);
  });
});
