import { fileURLToPath } from 'node:url';
import type { IpcOutput } from '../shared/ipc';
import type { Stores } from './persistence/store';
import type { CloneJobs } from './workspace/clone-job';
import type { WorkspaceService } from './workspace/workspace-service';

export type FolderPurpose = 'open-repository' | 'clone-destination';

type Dependencies = {
  stores: Stores;
  workspaces: WorkspaceService;
  clones: CloneJobs;
  pickFolder: (purpose: FolderPurpose) => Promise<string | null>;
};

/**
 * Main-process implementations of the IPC channels available so far. CLI detection and agents
 * join app:getState with US2 (T060, T062).
 */
export function createAppServices({ stores, workspaces, clones, pickFolder }: Dependencies) {
  return {
    async 'app:getState'(): Promise<IpcOutput<'app:getState'>> {
      const state = await stores.state.read();
      return {
        workspaces: workspaces.list(),
        recents: state.recents,
        clis: state.customClis,
        permission: state.permission,
      };
    },
    'workspace:open': ({ path }: { path: string }) => workspaces.open(path),
    'workspace:initRepo': ({ path }: { path: string }) => workspaces.initRepo(path),
    'workspace:close': ({ id }: { id: string }) => workspaces.close(id),
    'workspace:clone': ({ url, destination }: { url: string; destination: string }) =>
      clones.start({ url, destination }),
    'dialog:pickFolder': ({ purpose }: { purpose: FolderPurpose }) => pickFolder(purpose),
  };
}

const samePath = (a: string, b: string) => {
  const normalize = (path: string) =>
    process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path.normalize('NFC');
  return normalize(a) === normalize(b);
};

/** IPC is only accepted from PACT's own renderer page (or the dev server in development). */
export function trustedSenderCheck({
  rendererHtml,
  devServerUrl,
}: {
  rendererHtml: string;
  devServerUrl: string | undefined;
}) {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
  return (url: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === 'file:') return samePath(fileURLToPath(parsed), rendererHtml);
    return devOrigin !== undefined && parsed.origin === devOrigin;
  };
}

/**
 * The electron-vite dev server URL, honored only when running unpackaged: in a packaged app an
 * environment variable must never be able to swap PACT's UI for another page.
 */
export const devServerUrl = (
  app: { isPackaged: boolean },
  env: Record<string, string | undefined>,
): string | undefined => (app.isPackaged ? undefined : env.ELECTRON_RENDERER_URL);
