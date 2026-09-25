import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createAdapters } from './agents/adapters';
import { AgentManager } from './agents/agent-manager';
import { CliRegistry } from './agents/cli-registry';
import { FreeTerminals } from './agents/free-terminals';
import { HookServer } from './agents/hook-server';
import { PermissionService } from './agents/permission-service';
import { createAppServices, devServerUrl, trustedSenderCheck } from './app-services';
import { resolveShellEnv } from './env/shell-env';
import { GitService } from './git/git-service';
import { createAgentServices, forwardTerminalEvents } from './ipc/agent-handlers';
import { createEventEmitter, registerHandlers } from './ipc/handlers';
import { openStores } from './persistence/store';
import { PtyManager } from './pty/pty-manager';
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
  const agents = new AgentManager({
    workspaces,
    registry,
    git,
    pty,
    hooks,
    hookUrl: () => hookUrl,
    resolveEnv: resolveShellEnv,
    onState: (event) => {
      emit('agent:state', event);
    },
    onBranch: (event) => {
      emit('agent:branch', event);
    },
    // FR-035: « reprise auto » of screen 1m, off until chosen.
    autoResume: async (workspaceId) =>
      (await permissions.resolve(workspaceId))?.autoResume ?? false,
    ...(clock ? { clock } : {}),
  });
  const freeTerminals = new FreeTerminals({
    workspaces,
    pty,
    resolveEnv: resolveShellEnv,
    platform: process.platform,
  });
  const prepareWorkspace = async (id: string) => {
    await agents.restore(id);
    await freeTerminals.restore(id);
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
  app.on('will-quit', () => {
    workspaces.dispose();
    // Agent states stay saved as they are; the processes end with the app (FR-038).
    void Promise.all([agents.dispose(), freeTerminals.dispose()]).then(async () => {
      await pty.dispose();
      await hooks.stop();
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
