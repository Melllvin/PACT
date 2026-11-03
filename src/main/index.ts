import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { IpcFailure } from '../shared/ipc';
import { PREVIEW_SCHEME } from '../shared/preview';
import { createAdapters } from './agents/adapters';
import { AgentManager } from './agents/agent-manager';
import { CliRegistry } from './agents/cli-registry';
import { FreeTerminals } from './agents/free-terminals';
import { HookServer } from './agents/hook-server';
import { PermissionService } from './agents/permission-service';
import { guardQuit, quitQuestion } from './app-lifecycle';
import { UsageService } from './usage/usage-service';
import { createUsageServices } from './ipc/usage-handlers';
import { createAppServices, devServerUrl, trustedSenderCheck } from './app-services';
import { resolveShellEnv } from './env/shell-env';
import { GitService } from './git/git-service';
import { createAgentServices, forwardTerminalEvents } from './ipc/agent-handlers';
import { createEventEmitter, registerHandlers } from './ipc/handlers';
import { createOrchestratorServices } from './ipc/orchestrator-handlers';
import { createPreviewServices } from './ipc/preview-handlers';
import { createReviewServices } from './ipc/review-handlers';
import { openStores } from './persistence/store';
import { PtyManager } from './pty/pty-manager';
import { IntegrationRequests } from './orchestrator/integration-requests';
import { OrchestratorService } from './orchestrator/orchestrator-service';
import type { McpTool } from './orchestrator/mcp';
import { createOrchestratorTools } from './orchestrator/tools';
import { createAgentTools } from './orchestrator/agent-tools';
import { LoopService } from './orchestrator/loop-service';
import { IssueService, ghCommand } from './orchestrator/issues';
import { IntegrationService } from './review/integration-service';
import { createPreviewHandler } from './preview/preview-protocol';
import { PreviewService } from './preview/preview-service';
import { ReviewService, watchRecursive } from './review/review-service';
import { TestRunner } from './review/test-runner';
import { applyTestMode, testClock } from './test-mode';
import { createMainWindow, RENDERER_HTML } from './window';
import { CloneJobs } from './workspace/clone-job';
import { WorkspaceService } from './workspace/workspace-service';

const AVAILABILITY_CHECK_MS = 3000;

applyTestMode(app, process.env);

// 004 US4 — the Aperçu's own scheme, declared before the app is ready (research R9).
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

void app.whenReady().then(async () => {
  const rendererUrl = devServerUrl(app, process.env);
  const windowEnv = { ELECTRON_RENDERER_URL: rendererUrl };
  const emit = createEventEmitter(() =>
    BrowserWindow.getAllWindows().map((win) => win.webContents),
  );

  const stores = openStores(app.getPath('userData'));
  // Git uses the login-shell environment so credential helpers and SSH keys work from the Finder.
  const git = new GitService({ env: await resolveShellEnv() });
  const workspaces = new WorkspaceService({
    git,
    stores,
    onStatus: (event) => {
      emit('workspace:status', event);
      // Spec edge case « dossier supprimé » (T121): what runs there stops; shells come back with it.
      if (event.status === 'unavailable') {
        void agents.suspend(event.id);
        void freeTerminals.suspend(event.id);
      } else {
        void freeTerminals.restore(event.id);
      }
    },
  });

  // US2 — CLIs, agents and free terminals.
  const registry = new CliRegistry({
    adapters: createAdapters({
      env: process.env,
      platform: process.platform,
      // CLIs without HTTP hooks run the built bridge with PACT's own binary (research.md R4).
      bridge: {
        executable: process.execPath,
        script: fileURLToPath(new URL('./hook-bridge.js', import.meta.url)),
      },
    }),
    resolveEnv: resolveShellEnv,
    stores,
  });
  const detection = registry.detect();
  const hooks = new HookServer();
  const hookUrl = await hooks.start();
  const pty = new PtyManager();
  forwardTerminalEvents(pty, emit);
  const permissions = new PermissionService({ stores, workspaces });
  // The e2e harness moves this clock itself from the main process (T106).
  const clock = testClock(process.env);
  if (clock) Object.assign(globalThis, { pactTestClock: clock });
  // 003 — the orchestrator of a workspace reaches PACT through its session plugin (R2).
  const orchestrator: OrchestratorService = new OrchestratorService({
    hooks,
    workspaces,
    onAction: (orchestratorId, action) => {
      emit('orchestrator:action', { ...action, orchestratorId });
    },
    rolesDir: join(app.getPath('userData'), 'roles'),
    // 004 R3 — the suite of skills ships beside the app (extraResources).
    skillsDir: app.isPackaged
      ? join(process.resourcesPath, 'skills')
      : join(app.getAppPath(), 'resources', 'skills'),
    // 004 US2 — the hand-off reports of the agents with a role go to their loop.
    agentTools: (agentId) =>
      createAgentTools({ onReport: (id, report) => loops.report(id, report) }, agentId),
    onTurnFinished: (agentId) => {
      loops.turnFinished(agentId);
    },
    // Read when the orchestrator calls: the services below exist by then.
    tools: (orchestratorId): McpTool[] =>
      createOrchestratorTools(
        {
          workspaces,
          agents,
          cliName: (cliId) => registry.list().find((cli) => cli.id === cliId)?.name ?? cliId,
          pending: (workspaceId) => review.updatePending(workspaceId),
          review,
          tests,
          wait: (agentIds, timeoutMs) => orchestrator.wait(orchestratorId, agentIds, timeoutMs),
          requests,
          loops,
          issues,
          clis: () => registry.list(),
          permissions,
          log: (entry) => {
            orchestrator.record(orchestratorId, entry);
          },
        },
        orchestratorId,
      ),
  });
  // 005 — the usage limits of the CLI accounts, as the agents' CLIs report them.
  const thresholds = (await stores.state.read()).usageThresholds;
  const usage = new UsageService({
    thresholds: () => thresholds,
    onState: (state) => {
      emit('usage:state', state);
    },
  });
  const agents: AgentManager = new AgentManager({
    workspaces,
    registry,
    git,
    pty,
    hooks,
    orchestrator,
    usage,
    onPromptTyped: (agentId, origin) => {
      if (origin === 'orchestrator') emit('orchestrator:prompted', { agentId });
    },
    hookUrl: () => hookUrl,
    resolveEnv: resolveShellEnv,
    // Its worktree no longer followed before it goes (on Windows a watch blocks the removal).
    onClosing: (agentId) => {
      review.close(agentId);
    },
    onState: (event) => {
      emit('agent:state', event);
      // 003 R5 — what the orchestrator of the workspace waits for.
      orchestrator.agentState(event);
      requests.agentState(event);
      // 002 US1 — « Revue → » follows the agents that are done with changes (FR-002).
      const workspace = workspaces
        .list()
        .find((ws) => ws.agents.some((a) => a.id === event.agentId));
      if (workspace) void review.updatePending(workspace.id);
      // A closed agent has left its workspace already: each one is checked again.
      else if (event.state === 'closed') {
        for (const ws of workspaces.list()) void review.updatePending(ws.id);
      }
      // US4 — an agent asked to resolve a conflict is checked again once its turn ends.
      integration.agentState(event.agentId, event.state);
    },
    onBranch: (event) => {
      emit('agent:branch', event);
    },
    // FR-035: « reprise auto » of screen 1m, off until chosen.
    autoResume: async (workspaceId) =>
      (await permissions.resolve(workspaceId))?.autoResume ?? false,
    ...(clock ? { clock } : {}),
  });
  // 002 US1 — the review of each agent's changes.
  const review = new ReviewService({
    git,
    workspaces,
    onChanged: (snapshot) => {
      emit('review:changed', snapshot);
    },
    onPending: (event) => {
      emit('review:pending', event);
    },
    // 004 R7 — the orchestrator hears of files two agents both change.
    onOverlap: (workspaceId, { agents: [agentId, otherId], files }) => {
      const other = workspaces.get(workspaceId)?.agents.find((a) => a.id === otherId);
      const name = other
        ? `${registry.list().find((cli) => cli.id === other.cliId)?.name ?? other.cliId} ${String(other.position)}`
        : otherId;
      const notice = {
        agentId,
        kind: 'overlap' as const,
        summary: `fichiers communs avec ${name} : ${files.join(', ')}`,
      };
      orchestrator.notice(workspaceId, notice);
      emit('orchestrator:report', { workspaceId, ...notice });
    },
    prompts: agents,
    tests: { latest: (agentId) => tests.latest(agentId) },
  });
  // 002 US2 — the tests of the Décision column and the integration into main.
  const tests = new TestRunner({
    env: resolveShellEnv,
    onUpdate: (run) => {
      emit('review:tests', run);
      // 004 FR-019 — PACT's own run of the tests is the proof of a loop.
      void loops.testRun(run);
    },
  });
  // 004 US2 — the dev ↔ test loops of the issues.
  const loops: LoopService = new LoopService({
    workspaces,
    git,
    review,
    tests,
    agents,
    notify: (workspaceId, notice) => {
      orchestrator.notice(workspaceId, notice);
      emit('orchestrator:report', { workspaceId, ...notice });
    },
    onChange: (workspaceId, change) => {
      emit('workspace:loops', { workspaceId, ...change });
    },
  });
  // 004 US4 — the Aperçu: an agent's worktree only, refreshed as its files change.
  const preview = new PreviewService({
    workspaces,
    watch: watchRecursive,
    onChanged: (agentId, path) => {
      emit('preview:changed', { agentId, path });
    },
    notify: (workspaceId, notice) => {
      orchestrator.notice(workspaceId, notice);
      emit('orchestrator:report', { workspaceId, ...notice });
    },
  });
  protocol.handle(
    PREVIEW_SCHEME,
    createPreviewHandler((agentId) => preview.worktreeOf(agentId)),
  );
  // 004 US3 — the issues, published with gh once the user confirms (R8).
  const issues = new IssueService({
    workspaces,
    gh: async (args, cwd) => {
      const command = ghCommand(process.env);
      if (!command) throw new Error('gh absent');
      const run = promisify(execFile);
      const env = await resolveShellEnv();
      return (await run(command.file, [...command.args, ...args], { cwd, env, encoding: 'utf8' }))
        .stdout;
    },
    notify: (workspaceId, notice) => {
      orchestrator.notice(workspaceId, notice);
      emit('orchestrator:report', { workspaceId, ...notice });
    },
    onChange: (workspaceId, change) => {
      emit('workspace:issues', { workspaceId, ...change });
    },
  });
  const integration = new IntegrationService({
    git,
    workspaces,
    agents,
    integrationsDir: join(app.getPath('userData'), 'integrations'),
    conflictsDir: join(app.getPath('userData'), 'conflicts'),
    prompts: agents,
    openPath: async (path) => {
      const failure = await shell.openPath(path);
      if (failure !== '') throw new IpcFailure('INTERNAL', failure);
    },
    onState: (state) => {
      emit('integration:state', state);
      // 003 US3 — an integration the orchestrator asked for: its outcome is told back.
      requests.integrationState(state);
      if (state.state !== 'integrated') return;
      // main moved: what is left to review changes with it.
      const workspace = workspaces
        .list()
        .find((ws) => ws.agents.some((a) => a.id === state.agentId));
      if (workspace) void review.updatePending(workspace.id);
    },
  });
  const requests: IntegrationRequests = new IntegrationRequests({
    workspaces,
    integration,
    git,
    notify: (workspaceId, event) => {
      orchestrator.push(workspaceId, event);
    },
    onChange: (workspaceId, list) => {
      emit('workspace:integrationRequests', { workspaceId, requests: list });
    },
  });
  // Integrations in progress do not outlive the app (R9): neither do their editor copies.
  await rm(join(app.getPath('userData'), 'conflicts'), { recursive: true, force: true });
  const freeTerminals = new FreeTerminals({
    workspaces,
    pty,
    resolveEnv: resolveShellEnv,
    platform: process.platform,
  });
  const prepareWorkspace = async (id: string) => {
    await agents.restore(id);
    await freeTerminals.restore(id);
    void review.updatePending(id);
  };

  for (const workspace of await workspaces.restore()) await prepareWorkspace(workspace.id);
  workspaces.startWatching(AVAILABILITY_CHECK_MS);
  const clones = new CloneJobs({
    git,
    workspaces,
    emit: (event) => {
      emit('clone:progress', event);
    },
  });

  registerHandlers(
    ipcMain,
    {
      ...createAppServices({
        stores,
        workspaces,
        clones,
        clis: async () => {
          await detection;
          return registry.list();
        },
        onOpened: prepareWorkspace,
        pickFolder: async (purpose) => {
          const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          const options = {
            title:
              purpose === 'open-repository' ? 'Choisir un dépôt Git' : 'Dossier de destination',
            properties: ['openDirectory', 'createDirectory'] as (
              'openDirectory' | 'createDirectory'
            )[],
          };
          const result = window
            ? await dialog.showOpenDialog(window, options)
            : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
      }),
      ...createAgentServices({
        registry,
        permissions,
        agents,
        freeTerminals,
        pty,
      }),
      ...createReviewServices({ review, tests, integration, workspaces }),
      ...createPreviewServices({ preview }),
      ...createUsageServices({ usage }),
      ...createOrchestratorServices({
        requests,
        orchestrator,
        agents,
        workspaces,
        loops,
        issues,
        clis: () => registry.list(),
      }),
    },
    {
      isTrustedSender: trustedSenderCheck({
        rendererHtml: RENDERER_HTML,
        devServerUrl: rendererUrl,
      }),
    },
  );

  createMainWindow(windowEnv);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windowEnv);
  });
  guardQuit({
    app,
    activeAgents: () => agents.activeCount(),
    confirm: async (count) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const question = quitQuestion(count);
      const { response } = window
        ? await dialog.showMessageBox(window, question)
        : await dialog.showMessageBox(question);
      return response === 0;
    },
    // Agent states stay saved as they are; the processes end with the app (FR-038).
    shutdown: async () => {
      workspaces.dispose();
      review.dispose();
      preview.dispose();
      tests.dispose();
      integration.dispose();
      orchestrator.dispose();
      usage.stop();
      await Promise.all([agents.dispose(), freeTerminals.dispose()]);
      await pty.dispose();
      await hooks.stop();
    },
    // e2e runs close the app themselves; no one is there to answer.
    skipConfirm: process.env.PACT_TEST_MODE === '1',
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
