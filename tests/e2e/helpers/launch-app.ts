import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export type LaunchedApp = { app: ElectronApplication; close(): Promise<void> };

/** Launches the built app in test mode with an isolated, throwaway userData directory. */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'pact-e2e-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, PACT_TEST_MODE: '1', PACT_USER_DATA_DIR: userDataDir },
  });
  return {
    app,
    async close() {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
