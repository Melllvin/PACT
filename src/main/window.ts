import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';

const fromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** The built renderer page, the only file:// page allowed to call IPC. */
export const RENDERER_HTML = fromHere('../renderer/index.html');

/**
 * Creates the single PACT window. `env` is injected so the dev/prod switch is testable.
 * With PACT_TEST_BACKGROUND=1 (e2e runs), the window is never shown and never throttled,
 * so the tests run without taking the screen or the focus.
 */
export function createMainWindow(env: NodeJS.ProcessEnv): BrowserWindow {
  const background = env.PACT_TEST_BACKGROUND === '1';
  const win = new BrowserWindow({
    show: !background,
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
      backgroundThrottling: !background,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  // 004 FR-026 — the Aperçu's frame never leaves its own scheme.
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('pact-preview://')) event.preventDefault();
  });

  const devServerUrl = env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(RENDERER_HTML);
  return win;
}
