import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Creates the single PACT window. `env` is injected so the dev/prod switch is testable. */
export function createMainWindow(env: NodeJS.ProcessEnv): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'PACT',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: fromHere('../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const devServerUrl = env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(fromHere('../renderer/index.html'));
  return win;
}
