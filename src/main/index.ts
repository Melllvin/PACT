import { app, BrowserWindow, ipcMain } from 'electron';
import { createAppServices, trustedSenderCheck } from './app-services';
import { registerHandlers } from './ipc/handlers';
import { openStores } from './persistence/store';
import { applyTestMode } from './test-mode';
import { createMainWindow, RENDERER_HTML } from './window';

applyTestMode(app, process.env);

void app.whenReady().then(() => {
  const stores = openStores(app.getPath('userData'));
  registerHandlers(ipcMain, createAppServices({ stores }), {
    isTrustedSender: trustedSenderCheck({
      rendererHtml: RENDERER_HTML,
      devServerUrl: process.env.ELECTRON_RENDERER_URL,
    }),
  });

  createMainWindow(process.env);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(process.env);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
