import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { GitService } from '../../../src/main/git/git-service';
import { OrchestratorService } from '../../../src/main/orchestrator/orchestrator-service';
import { createOrchestratorTools } from '../../../src/main/orchestrator/tools';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { AgentState } from '../../../src/shared/model';
import { FAKE_CLI, scenarioPath } from '../../fixtures/fake-cli/paths';

// 003 — a workspace with fake agents, PACT's local server and the orchestrator service, as the
// app wires them; each suite adds what it needs on top.

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness() {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-orchestrator-')));
  const repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');

  const userData = join(root, 'userData');
  const stores: Stores = openStores(userData);
  const gitService = new GitService({ env: gitEnv });
  const workspaces = new WorkspaceService({ git: gitService, stores });
  const workspace = await workspaces.open(repo);
  const pty = new PtyManager();
  const hooks = new HookServer();
  await hooks.start();
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  const events: AgentStateEvent[] = [];
  /** The scenario each agent runs, by position; `default` for the others. */
  const scenarios: Record<string, string> = { default: 'prompt-then-done' };
  /** The agents with changes to review, as ReviewService would tell; set by a suite. */
  const pending = { ids: [] as string[] };
  const typed: { agentId: string; origin: string }[] = [];
  const orchestrator = new OrchestratorService({
    hooks,
    pluginsDir: join(userData, 'orchestrator'),
    tools: (orchestratorId) =>
      createOrchestratorTools(
        {
          workspaces,
          agents: manager,
          cliName: () => 'Faux CLI',
          pending: () => Promise.resolve(pending.ids),
        },
        orchestratorId,
      ),
  });

  const createManager = async () => {
    const registry = new CliRegistry({
      adapters: [adapter],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    await registry.detect();
    return new AgentManager({
      workspaces,
      registry,
      git: gitService,
      pty,
      hooks,
      hookUrl: () => hooks.mcpUrl().replace(/\/mcp$/, ''),
      // The fake CLI reads its scenario from the environment: one per launch, in order.
      resolveEnv: () =>
        Promise.resolve({
          ...gitEnv,
          FAKE_CLI_SCENARIO: scenarioPath(scenarios.next ?? scenarios.default ?? ''),
        }),
      isPortInUse: () => Promise.resolve(false),
      onState: (event) => events.push(event),
      onPromptTyped: (agentId, origin) => typed.push({ agentId, origin }),
      orchestrator,
    });
  };
  // Assigned at once: the tools above only read it when an orchestrator calls them.
  let manager: AgentManager = await createManager();

  const current = (id: string) => workspaces.get(workspace.id)?.agents.find((a) => a.id === id);

  const waitFor = async (check: () => boolean, what: string, id = '', timeoutMs = 10_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error(`${what}\n${id ? pty.history(id) : ''}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const waitForState = (id: string, state: AgentState) =>
    waitFor(
      () =>
        current(id)?.state === state && events.findLast((e) => e.agentId === id)?.state === state,
      `${id} stayed ${String(current(id)?.state)} instead of ${state}`,
      id,
    );

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

  /** Launches agents with `scenario`, waiting until each awaits a prompt. */
  const launch = async (drafts: AgentDraft[], scenario = scenarios.default) => {
    scenarios.next = scenario ?? 'prompt-then-done';
    const agents = await manager.launch({
      workspaceId: workspace.id,
      agents: drafts,
      counters: { freeTerminal: 0 },
    });
    delete scenarios.next;
    for (const agent of agents) await waitForState(agent.id, 'awaiting-prompt');
    return agents;
  };

  return {
    root,
    repo,
    userData,
    stores,
    workspaces,
    workspace,
    pty,
    hooks,
    adapter,
    events,
    orchestrator,
    pending,
    typed,
    get manager() {
      return manager;
    },
    async restart() {
      await manager.dispose();
      manager = await createManager();
      await manager.restore(workspace.id);
    },
    current,
    waitFor,
    waitForState,
    draft,
    launch,
    async dispose() {
      await manager.dispose();
      await pty.dispose();
      await hooks.stop();
      workspaces.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** A tools/call as Claude Code makes it, with the orchestrator's token. */
export async function callTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pact-token': token },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!response.ok) return { status: response.status, text: '', isError: true, json: null };
  const reply = (await response.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { code: number; message: string };
  };
  const [text, json] = reply.result?.content.map((c) => c.text) ?? [reply.error?.message ?? ''];
  return {
    status: response.status,
    text: text ?? '',
    isError: reply.result?.isError === true || reply.error !== undefined,
    json: json === undefined ? null : (JSON.parse(json) as unknown),
  };
}
