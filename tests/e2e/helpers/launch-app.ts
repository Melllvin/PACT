import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export type LaunchedApp = {
  app: ElectronApplication;
  userDataDir: string;
  /** Quits the app; pass `keepData` to relaunch later on the same userData (restart tests). */
  close(options?: { keepData?: boolean }): Promise<void>;
};

/** Launches the built app in test mode with an isolated userData directory. */
export async function launchApp({
  userDataDir,
  env = {},
}: { userDataDir?: string; env?: Record<string, string> } = {}): Promise<LaunchedApp> {
  const dir = userDataDir ?? (await mkdtemp(join(tmpdir(), 'pact-e2e-')));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ...env, PACT_TEST_MODE: '1', PACT_USER_DATA_DIR: dir },
  });
  return {
    app,
    userDataDir: dir,
    async close({ keepData = false } = {}) {
      await app.close();
      if (!keepData) await rm(dir, { recursive: true, force: true });
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
