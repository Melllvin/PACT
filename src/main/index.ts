import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createAppServices, devServerUrl, trustedSenderCheck } from './app-services';
import { resolveShellEnv } from './env/shell-env';
import { GitService } from './git/git-service';
import { createEventEmitter, registerHandlers } from './ipc/handlers';
import { openStores } from './persistence/store';
import { applyTestMode } from './test-mode';
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
  await workspaces.restore();
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
    createAppServices({
      stores,
      workspaces,
      clones,
      pickFolder: async (purpose) => {
        const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const options = {
          title: purpose === 'open-repository' ? 'Choisir un dépôt Git' : 'Dossier de destination',
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
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
