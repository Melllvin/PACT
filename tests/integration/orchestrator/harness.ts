import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter } from '../../../src/main/agents/adapters/fake';
import { AgentManager, type AgentStateEvent } from '../../../src/main/agents/agent-manager';
import { CliRegistry } from '../../../src/main/agents/cli-registry';
import { HookServer } from '../../../src/main/agents/hook-server';
import { PermissionService } from '../../../src/main/agents/permission-service';
import { GitService } from '../../../src/main/git/git-service';
import { createAgentTools } from '../../../src/main/orchestrator/agent-tools';
import { IssueService } from '../../../src/main/orchestrator/issues';
import { LoopService } from '../../../src/main/orchestrator/loop-service';
import { OrchestratorService } from '../../../src/main/orchestrator/orchestrator-service';
import { WakeService, eventsFile } from '../../../src/main/orchestrator/wake-service';
import { createOrchestratorTools } from '../../../src/main/orchestrator/tools';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { IntegrationService } from '../../../src/main/review/integration-service';
import { ReviewService } from '../../../src/main/review/review-service';
import { TestRunner } from '../../../src/main/review/test-runner';
import { PtyManager } from '../../../src/main/pty/pty-manager';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import type { AgentDraft } from '../../../src/shared/ipc';
import type { AgentState, Workspace } from '../../../src/shared/model';
import type { OrchestratorAction } from '../../../src/shared/orchestrator';
import type { Integration } from '../../../src/shared/review';
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

type ExchangesModule = typeof import('../../../src/main/orchestrator/exchange-service');

/** `managerOptions`: extra AgentManager options (fix-send-prompt: submitDelayMs, submitTimeoutMs). */
export async function createHarness(managerOptions: Record<string, unknown> = {}) {
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
  // 007 — the journal of the workspace. Loaded when the module exists, so that the suites that
  // do not use it keep running while it is being written.
  const exchangesPath = '../../../src/main/orchestrator/exchange-service';
  const exchangesModule = (await import(/* @vite-ignore */ exchangesPath).catch(
    () => null,
  )) as ExchangesModule | null;
  /** What `workspace:exchanges` announced, in order. */
  const exchangesHeard: unknown[] = [];
  const exchanges = exchangesModule
    ? new exchangesModule.ExchangeService({
        workspaces,
        onChange: (_workspaceId: string, journal: unknown) => exchangesHeard.push(journal),
      })
    : undefined;
  const withExchanges = exchanges ? { exchanges } : {};
  // 007 — the wake, wired as the app does: a message recorded for an agent types ONE pointer line.
  const wake = exchanges
    ? new WakeService({
        workspaces,
        type: (agentId, line) => manager.sendPrompt(agentId, line, 'wake'),
        inputBusy: (agentId) => manager.promptState(agentId) === 'busy',
        setNotice: (agentId, notice) => {
          void manager.setWakeNotice(agentId, notice).catch(() => undefined);
        },
        usageHeld: () => false,
        file: eventsFile({
          exchanges,
          agents: {
            hasMcp: (id) => manager.hasMcp(id),
            writeEventsFile: (id, text, before) => manager.writeEventsFile(id, text, before),
          },
        }),
      })
    : undefined;
  if (exchanges && wake) {
    exchanges.onRecorded((workspaceId, message) => {
      wake.notify(workspaceId, message);
    });
  }
  const pty = new PtyManager();
  /** The environment each agent was last started with (004: its agent MCP access). */
  const envs = new Map<string, Record<string, string | undefined>>();
  const start = pty.start.bind(pty);
  pty.start = (id, spec) => {
    envs.set(id, { ...spec.env });
    start(id, spec);
  };
  const hooks = new HookServer();
  await hooks.start();
  const adapter = new FakeAdapter({ cliPath: FAKE_CLI, platform: process.platform });
  const events: AgentStateEvent[] = [];
  /** The scenario each agent runs, by position; `default` for the others. */
  const scenarios: Record<string, string> = { default: 'prompt-then-done' };
  /** The agents with changes to review, as ReviewService would tell; set by a suite. */
  const pending = { ids: [] as string[] };
  /** 005 — the usage warning of each CLI, as UsageService would tell; set by a suite. */
  const usageWarnings: Record<string, string> = {};
  /**
   * 009 — the pause of the account of each CLI, as `UsageLimitService.pausedFor` would tell; set by a suite.
   * Given to the tools by a spread, so that the harness compiles before `pausedFor` is a dependency.
   */
  const usagePauses: Record<
    string,
    { windows: { label: string }[]; resumeAt: string | null } | undefined
  > = {};
  const pausedForTools = { pausedFor: (cliId: string) => usagePauses[cliId] ?? null };
  const typed: { agentId: string; origin: string }[] = [];
  const review = new ReviewService({ git: gitService, workspaces });
  /** What `orchestrator:report` announced, in order (004 US2). */
  const reports: { workspaceId: string; agentId: string; kind: string; summary: string }[] = [];
  const tests = new TestRunner({
    env: () => Promise.resolve(gitEnv),
    onUpdate: (run) => {
      void loops.testRun(run);
    },
  });
  /** What `orchestrator:action` announced, in order (US5). */
  const actionsHeard: (OrchestratorAction & { orchestratorId: string })[] = [];
  const orchestrator: OrchestratorService = new OrchestratorService({
    hooks,
    workspaces,
    rolesDir: join(userData, 'roles'),
    skillsDir: 'resources/skills',
    ...withExchanges,
    onAction: (orchestratorId, action) => actionsHeard.push({ ...action, orchestratorId }),
    agentTools: (agentId) =>
      createAgentTools(
        { onReport: (id, report) => loops.report(id, report), ...withExchanges },
        agentId,
      ),
    onTurnFinished: (agentId) => {
      loops.turnFinished(agentId);
    },
    tools: (orchestratorId) =>
      createOrchestratorTools(
        {
          workspaces,
          agents: manager,
          cliName: () => 'Faux CLI',
          pending: () => Promise.resolve(pending.ids),
          review,
          tests,
          wait: (agentIds, timeoutMs) => orchestrator.wait(orchestratorId, agentIds, timeoutMs),
          // 008 — the delivery has its own harness (tests/integration/delivery).
          delivery: { request: () => Promise.reject(new Error('no delivery in this harness')) },
          loops,
          issues,
          clis: () => registry.list(),
          usageWarning: (cliId) => usageWarnings[cliId] ?? null,
          ...pausedForTools,
          permissions,
          ...withExchanges,
          log: (entry) => {
            orchestrator.record(orchestratorId, entry);
          },
        },
        orchestratorId,
      ),
  });

  /** What `integration:state` announced, in order. */
  const integrations: Integration[] = [];
  // As the app wires them: the agents are read when an integration ends.
  const integration = new IntegrationService({
    git: gitService,
    workspaces,
    agents: { close: (id, options) => manager.close(id, options) },
    prompts: { sendPrompt: (id, text) => manager.sendPrompt(id, text) },
    integrationsDir: join(userData, 'integrations'),
    conflictsDir: join(userData, 'conflicts'),
    onState: (state) => {
      integrations.push(state);
    },
  });
  const loops: LoopService = new LoopService({
    workspaces,
    git: gitService,
    review,
    tests,
    agents: { escalate: (id, model) => manager.escalate(id, model) },
    notify: (workspaceId, notice) => {
      orchestrator.notice(workspaceId, notice);
      reports.push({ workspaceId, ...notice });
    },
    // 007 R14 — the instructions and the verdict of a loop go through the journal, as in the app.
    ...(exchanges
      ? {
          message: (workspaceId: string, draft: Parameters<typeof exchanges.record>[1]) =>
            exchanges.record(workspaceId, draft),
        }
      : {}),
  });

  /** `gh` as a suite fakes it (004 US3): each call, and what answers it. */
  const gh = {
    calls: [] as { args: string[]; cwd: string }[],
    answer: (args: string[]): Promise<string> =>
      args[0] === 'issue'
        ? Promise.resolve(`https://github.com/pact/test/issues/${String(gh.calls.length)}\n`)
        : Promise.resolve('{"url":"https://github.com/pact/test"}'),
  };
  /** What `workspace:issues` announced, in order. */
  const issueChanges: { workspaceId: string; issues: unknown[]; publishRequests: unknown[] }[] = [];
  const issues = new IssueService({
    workspaces,
    gh: (args, cwd) => {
      gh.calls.push({ args, cwd });
      return gh.answer(args);
    },
    notify: (workspaceId, notice) => {
      orchestrator.notice(workspaceId, notice);
      reports.push({ workspaceId, ...notice });
    },
    onChange: (workspaceId, change) => issueChanges.push({ workspaceId, ...change }),
  });

  const permissions = new PermissionService({ stores, workspaces });
  let registry: CliRegistry;
  const createManager = async () => {
    registry = new CliRegistry({
      adapters: [adapter],
      resolveEnv: () => Promise.resolve({}),
      stores,
    });
    await registry.detect();
    const created = new AgentManager({
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
      onState: (event) => {
        events.push(event);
        orchestrator.agentState(event);
      },
      onPromptTyped: (agentId, origin) => typed.push({ agentId, origin }),
      orchestrator,
      ...managerOptions,
    });
    if (wake) created.setWake(wake);
    return created;
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
    usageWarnings,
    usagePauses,
    typed,
    /** 007 — the wake, as the app wires it; `deliver(id)` skips the window of 5 s. */
    wake,
    review,
    tests,
    integration,
    integrations,
    permissions,
    actionsHeard,
    loops,
    reports,
    issues,
    gh,
    issueChanges,
    exchanges,
    exchangesHeard,
    /** The messages of the journal of the workspace, as they are now. */
    journal() {
      const kept = (
        workspaces.get(workspace.id) as { exchanges?: Workspace['exchanges'] } | undefined
      )?.exchanges?.messages;
      if (!kept) throw new Error('007 : workspace.exchanges absent (src/shared/exchanges.ts)');
      return kept;
    },
    get manager() {
      return manager;
    },
    get registry() {
      return registry;
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
    launchedEnv: (agentId: string) => envs.get(agentId) ?? {},
    async dispose() {
      review.dispose();
      tests.dispose();
      wake?.dispose();
      orchestrator.dispose();
      await manager.dispose();
      await pty.dispose();
      await hooks.stop();
      workspaces.dispose();
      // The agents' last state changes are still being written: let them land first.
      await new Promise((r) => setTimeout(r, 100));
      await stores.workspace(workspace.id).read();
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
