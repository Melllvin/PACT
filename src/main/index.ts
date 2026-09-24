import { app, BrowserWindow } from 'electron';
import { applyTestMode } from './test-mode';
import { createMainWindow } from './window';

applyTestMode(app, process.env);

void app.whenReady().then(() => {
  createMainWindow(process.env);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(process.env);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
