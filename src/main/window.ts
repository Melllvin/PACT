import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** The built renderer page, the only file:// page allowed to call IPC. */
export const RENDERER_HTML = fromHere('../renderer/index.html');

/** Creates the single PACT window. `env` is injected so the dev/prod switch is testable. */
export function createMainWindow(env: NodeJS.ProcessEnv): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'PACT',
    // --bg of tokens.css: no flash of another color before the page paints.
    backgroundColor: '#09090b',
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
  else void win.loadFile(RENDERER_HTML);
  return win;
}
