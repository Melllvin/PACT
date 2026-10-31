import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IpcFailure } from '../shared/ipc';
import { createAdapters } from './agents/adapters';
import { AgentManager } from './agents/agent-manager';
import { CliRegistry } from './agents/cli-registry';
import { FreeTerminals } from './agents/free-terminals';
import { HookServer } from './agents/hook-server';
import { PermissionService } from './agents/permission-service';
import { guardQuit, quitQuestion } from './app-lifecycle';
import { createAppServices, devServerUrl, trustedSenderCheck } from './app-services';
import { resolveShellEnv } from './env/shell-env';
import { GitService } from './git/git-service';
import { createAgentServices, forwardTerminalEvents } from './ipc/agent-handlers';
import { createEventEmitter, registerHandlers } from './ipc/handlers';
import { createReviewServices } from './ipc/review-handlers';
import { openStores } from './persistence/store';
import { PtyManager } from './pty/pty-manager';
import { OrchestratorService } from './orchestrator/orchestrator-service';
import type { McpTool } from './orchestrator/mcp';
import { createOrchestratorTools } from './orchestrator/tools';
import { IntegrationService } from './review/integration-service';
import { ReviewService } from './review/review-service';
import { TestRunner } from './review/test-runner';
import { applyTestMode, testClock } from './test-mode';
import { createMainWindow, RENDERER_HTML } from './window';
import { CloneJobs } from './workspace/clone-job';
import { WorkspaceService } from './workspace/workspace-service';

const AVAILABILITY_CHECK_MS = 3000;

applyTestMode(app, process.env);

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
    pluginsDir: join(app.getPath('userData'), 'orchestrator'),
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
        },
        orchestratorId,
      ),
  });
  const agents: AgentManager = new AgentManager({
    workspaces,
    registry,
    git,
    pty,
    hooks,
    orchestrator,
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
    prompts: agents,
    tests: { latest: (agentId) => tests.latest(agentId) },
  });
  // 002 US2 — the tests of the Décision column and the integration into main.
  const tests = new TestRunner({
    env: resolveShellEnv,
    onUpdate: (run) => {
      emit('review:tests', run);
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
      if (state.state !== 'integrated') return;
      // main moved: what is left to review changes with it.
      const workspace = workspaces
        .list()
        .find((ws) => ws.agents.some((a) => a.id === state.agentId));
      if (workspace) void review.updatePending(workspace.id);
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
      tests.dispose();
      integration.dispose();
      orchestrator.dispose();
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
