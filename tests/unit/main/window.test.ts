import { beforeEach, describe, expect, it, vi } from 'vitest';

const instances: FakeWindow[] = [];

class FakeWindow {
  options: Electron.BrowserWindowConstructorOptions;
  loadURL = vi.fn(() => Promise.resolve());
  loadFile = vi.fn(() => Promise.resolve());
  webContents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  };
  constructor(options: Electron.BrowserWindowConstructorOptions) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }));

const { createMainWindow } = await import('../../../src/main/window');

const lastWindow = () => {
  const win = instances.at(-1);
  if (!win) throw new Error('no window created');
  return win;
};

describe('createMainWindow', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('opens a 1440×900 window titled PACT', () => {
    createMainWindow({});
    expect(lastWindow().options).toMatchObject({ width: 1440, height: 900, title: 'PACT' });
  });

  it('isolates the renderer from Node', () => {
    createMainWindow({});
    expect(lastWindow().options.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });

  it('uses the CommonJS preload build (sandboxed preloads cannot be ESM)', () => {
    createMainWindow({});
    expect(lastWindow().options.webPreferences?.preload).toMatch(/[\\/]preload[\\/]index\.cjs$/);
  });

  it('loads the dev server URL when electron-vite provides one', () => {
    createMainWindow({ ELECTRON_RENDERER_URL: 'http://localhost:5173' });
    expect(lastWindow().loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(lastWindow().loadFile).not.toHaveBeenCalled();
  });

  it('loads the built renderer otherwise', () => {
    createMainWindow({});
    expect(lastWindow().loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]renderer[\\/]index\.html$/),
    );
  });

  it('denies every window.open request', () => {
    createMainWindow({});
    const [handler] = lastWindow().webContents.setWindowOpenHandler.mock.calls[0] as [
      () => { action: string },
    ];
    expect(handler()).toEqual({ action: 'deny' });
  });

  it('blocks navigation away from the app', () => {
    createMainWindow({});
    const call = lastWindow().webContents.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    );
    const preventDefault = vi.fn();
    (call?.[1] as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });
});
