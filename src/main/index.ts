import { app, BrowserWindow, ipcMain } from 'electron';
import { createAppServices, devServerUrl, trustedSenderCheck } from './app-services';
import { registerHandlers } from './ipc/handlers';
import { openStores } from './persistence/store';
import { applyTestMode } from './test-mode';
import { createMainWindow, RENDERER_HTML } from './window';

applyTestMode(app, process.env);

void app.whenReady().then(() => {
  const rendererUrl = devServerUrl(app, process.env);
  const windowEnv = { ELECTRON_RENDERER_URL: rendererUrl };
  const stores = openStores(app.getPath('userData'));
  registerHandlers(ipcMain, createAppServices({ stores }), {
    isTrustedSender: trustedSenderCheck({
      rendererHtml: RENDERER_HTML,
      devServerUrl: rendererUrl,
    }),
  });

  createMainWindow(windowEnv);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windowEnv);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
