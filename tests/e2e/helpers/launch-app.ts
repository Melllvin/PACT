import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export type LaunchedApp = {
  app: ElectronApplication;
  userDataDir: string;
  /** Quits the app; pass `keepData` to relaunch later on the same userData (restart tests). */
  close(options?: { keepData?: boolean }): Promise<void>;
};

/**
 * With PACT_E2E_PACKAGED=1, the app packaged by `electron-builder --dir` (T125): node-pty must load
 * from outside the asar, as it will for users.
 */
export const packagedExecutable = (platform = process.platform, arch = process.arch) =>
  platform === 'darwin'
    ? resolve(`dist/mac${arch === 'arm64' ? '-arm64' : ''}/PACT.app/Contents/MacOS/PACT`)
    : platform === 'win32'
      ? resolve(`dist/win${arch === 'arm64' ? '-arm64' : ''}-unpacked/PACT.exe`)
      : resolve('dist/linux-unpacked/pact');

/**
 * Launches the built app in test mode with an isolated userData directory, and a home of its own:
 * closing fails if the app or its agents wrote in its `.claude` or `.codex` (004 SC-007).
 */
export async function launchApp({
  userDataDir,
  env = {},
}: { userDataDir?: string; env?: Record<string, string> } = {}): Promise<LaunchedApp> {
  const dir = userDataDir ?? (await mkdtemp(join(tmpdir(), 'pact-e2e-')));
  const home = await mkdtemp(join(tmpdir(), 'pact-e2e-home-'));
  const packaged = process.env.PACT_E2E_PACKAGED === '1';
  const app = await electron.launch({
    ...(packaged ? { executablePath: packagedExecutable(), args: [] } : { args: ['.'] }),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CODEX_HOME: join(home, '.codex'),
      // On macOS the app runs hidden, without a Dock icon; PACT_E2E_FOREGROUND=1 shows it to debug
      // a test. Windows keeps it shown: a never-shown window stalls its rendering there.
      PACT_TEST_BACKGROUND:
        process.platform === 'darwin' && process.env.PACT_E2E_FOREGROUND !== '1' ? '1' : '0',
      ...env,
      PACT_TEST_MODE: '1',
      PACT_USER_DATA_DIR: dir,
    },
  });
  return {
    app,
    userDataDir: dir,
    async close({ keepData = false } = {}) {
      await app.close();
      if (!keepData) await rm(dir, { recursive: true, force: true });
      const written = ['.claude', '.codex'].filter((name) => existsSync(join(home, name)));
      await rm(home, { recursive: true, force: true });
      if (written.length > 0) throw new Error(`PACT a écrit dans ~/${written.join(' et ~/')}.`);
    },
  };
}

/** Makes the next native folder pickers return `paths`, in order (Electron's dialog is mocked). */
export async function answerFolderPickers(app: ElectronApplication, ...paths: string[]) {
  await app.evaluate(({ dialog }, queued) => {
    dialog.showOpenDialog = () => {
      const next = queued.shift();
      return Promise.resolve(
        next === undefined
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [next] },
      );
    };
  }, paths);
}
