import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import type { Clock } from '../../../src/main/agents/auto-resume';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentState, Workspace } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// T105 — US7, FR-036: the resume scheduled after a rate limit of the fake CLI, on a test clock.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** The fake CLI resets at 09:30 (scenarios `rate-limit*`): the clock starts at 09:00. */
const RESET = '2030-01-01T09:30:00.000Z';

/** Time moves only when a test says so; due timers then run. */
class TestClock implements Clock {
  private current = new Date('2030-01-01T09:00:00.000Z');
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

  advanceTo(iso: string) {
    this.current = new Date(iso);
    for (const timer of [...this.timers]) {
      if (timer.at <= +this.current) {
        this.timers.delete(timer);
        timer.run();
      }
    }
  }
}

let root: string;
let stores: Stores;
let workspaces: WorkspaceService;
let workspace: Workspace;
let pty: PtyManager;
let hooks: HookServer;
let manager: AgentManager;
let clock: TestClock;
let events: AgentStateEvent[];
let scenario: string;
let autoResume: boolean;
/** Set when the shell environment fails: the agent cannot start again. */
let envError: Error | null;

const createManager = async () => {
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
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
    resolveEnv: () =>
      envError
        ? Promise.reject(envError)
        : Promise.resolve({ ...gitEnv, FAKE_CLI_SCENARIO: scenarioPath(scenario) }),
    isPortInUse: () => Promise.resolve(false),
    onState: (event) => events.push(event),
    autoResume: () => Promise.resolve(autoResume),
    clock,
  });
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

/** Launches one agent and types a prompt that meets the rate limit of the scenario. */
const limited = async () => {
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
  pty.write(agent.id, 'Travaille\r');
  await waitForOutput(agent.id, 'Rate limit reached');
  return agent.id;
};

const continues = (write: { mock: { calls: unknown[][] } }) =>
  write.mock.calls.filter(([, data]) => data === 'continue\r').length;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-resume-')));
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
  clock = new TestClock();
  events = [];
  scenario = 'rate-limit';
  autoResume = true;
  envError = null;
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

describe('auto resume after a rate limit', { timeout: 30_000 }, () => {
  it('schedules the resume at the reset time, announced with the error', async () => {
    const id = await limited();
    await waitForState(id, 'error');
    const scheduled = { agentId: id, at: RESET, attempt: 0 };
    expect(current(id)?.scheduledResume).toEqual(scheduled);
    expect(events.find((e) => e.agentId === id && e.state === 'error')?.scheduledResume).toEqual(
      scheduled,
    );
  });

  it('resumes the same session once the process has exited (buildResume)', async () => {
    const id = await limited();
    await waitFor(() => current(id)?.lastError?.code === 1, 'no exit', id);
    const sessionId = current(id)?.sessionId;
    clock.advanceTo(RESET);
    await waitForOutput(id, `Session reprise ${String(sessionId)}`);
    await waitForState(id, 'awaiting-prompt');
    expect(current(id)).toMatchObject({ lastError: null, scheduledResume: null });
  });

  it('types « continue » in a CLI still alive, once', async () => {
    scenario = 'rate-limit-alive';
    const id = await limited();
    await waitForState(id, 'error');
    const write = vi.spyOn(pty, 'write');
    clock.advanceTo(RESET);
    await waitForOutput(id, 'Reprise');
    await waitForState(id, 'done');
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    expect(continues(write)).toBe(1);
    expect(current(id)?.scheduledResume).toBeNull();
  });

  it('does not resume a CLI that resumed on its own (quota_auto_resume_fired)', async () => {
    scenario = 'rate-limit-native-resume';
    const id = await limited();
    const write = vi.spyOn(pty, 'write');
    await waitForOutput(id, 'Reprise');
    await waitForState(id, 'done');
    expect(events.some((e) => e.agentId === id && e.scheduledResume)).toBe(true);
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 200));
    expect(continues(write)).toBe(0);
    expect(current(id)).toMatchObject({ state: 'done', scheduledResume: null });
  });

  it('schedules nothing when auto resume is off: manual actions only', async () => {
    autoResume = false;
    scenario = 'rate-limit-alive';
    const id = await limited();
    await waitForState(id, 'error');
    const write = vi.spyOn(pty, 'write');
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 200));
    expect(current(id)?.scheduledResume).toBeNull();
    expect(continues(write)).toBe(0);
  });

  it('« Annuler » removes the scheduled resume and keeps the error', async () => {
    scenario = 'rate-limit-alive';
    const id = await limited();
    await waitForState(id, 'error');
    const write = vi.spyOn(pty, 'write');
    await manager.cancelAutoResume(id);
    expect(current(id)).toMatchObject({ state: 'error', scheduledResume: null });
    expect(events.findLast((e) => e.agentId === id)?.scheduledResume).toBeNull();
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 200));
    expect(continues(write)).toBe(0);
  });

  it('« Reprendre » replaces the scheduled resume: « continue » is typed once', async () => {
    scenario = 'rate-limit-alive';
    const id = await limited();
    await waitForState(id, 'error');
    const write = vi.spyOn(pty, 'write');
    await manager.resume(id);
    await waitForState(id, 'done');
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 200));
    expect(continues(write)).toBe(1);
  });

  it('a line the user types in the terminal replaces the scheduled resume (no prompt hook)', async () => {
    scenario = 'rate-limit-alive';
    const id = await limited();
    await waitForState(id, 'error');
    const write = vi.spyOn(pty, 'write');
    manager.typed(id, 'con');
    expect(current(id)?.scheduledResume).not.toBeNull();
    manager.typed(id, 'tinue\r');
    await waitFor(() => current(id)?.scheduledResume === null, 'resume kept', id);
    clock.advanceTo('2030-01-01T12:00:00.000Z');
    await new Promise((r) => setTimeout(r, 200));
    expect(continues(write)).toBe(0);
  });

  it('ignores what is typed in a terminal that is no agent', () => {
    expect(() => {
      manager.typed('free-terminal', 'ls\r');
    }).not.toThrow();
  });

  it('keeps the resume of a closed workspace for the next time it opens', async () => {
    const id = await limited();
    await waitFor(() => current(id)?.lastError?.code === 1, 'no exit', id);
    await workspaces.close(workspace.id);
    clock.advanceTo(RESET);
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.history(id)).not.toContain('Session reprise');
    workspace = await workspaces.open(workspace.path);
    await manager.restore(workspace.id);
    clock.advanceTo(RESET); // the time has passed: due at once
    await waitForState(id, 'awaiting-prompt');
    expect(pty.history(id)).toContain('Session reprise');
  });

  it('drops the resume when the agent cannot start again at its time', async () => {
    const id = await limited();
    await waitFor(() => current(id)?.lastError?.code === 1, 'no exit', id);
    envError = new Error('shell gone');
    clock.advanceTo(RESET);
    await waitFor(() => current(id)?.scheduledResume === null, 'resume kept', id);
    expect(current(id)).toMatchObject({ state: 'error', lastError: { kind: 'rate-limit' } });
  });

  it('does not resume a saved resume whose error is no longer a rate limit', async () => {
    const id = await limited();
    await waitFor(() => current(id)?.lastError?.code === 1, 'no exit', id);
    await manager.dispose();
    await workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) =>
        a.id === id ? { ...a, lastError: { code: 1, kind: 'crash', message: 'Arrêté' } } : a,
      ),
    }));
    manager = await createManager();
    await manager.restore(workspace.id);
    clock.advanceTo(RESET);
    await new Promise((r) => setTimeout(r, 200));
    expect(current(id)).toMatchObject({ state: 'error', lastError: { kind: 'crash' } });
    expect(pty.history(id)).not.toContain('Session reprise');
  });

  it('resumes after a restart of PACT a resume saved before it', async () => {
    const id = await limited();
    await waitFor(() => current(id)?.lastError?.code === 1, 'no exit', id);
    await manager.dispose();
    manager = await createManager();
    await manager.restore(workspace.id);
    expect(current(id)?.scheduledResume).toMatchObject({ at: RESET });
    clock.advanceTo(RESET);
    await waitForState(id, 'awaiting-prompt');
    expect(current(id)?.scheduledResume).toBeNull();
  });
});
