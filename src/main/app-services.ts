import { fileURLToPath } from 'node:url';
import type { IpcOutput } from '../shared/ipc';
import type { CliDefinition, Workspace } from '../shared/model';
import type { Stores } from './persistence/store';
import type { CloneJobs } from './workspace/clone-job';
import type { WorkspaceService } from './workspace/workspace-service';

export type FolderPurpose = 'open-repository' | 'clone-destination';

type Dependencies = {
  stores: Stores;
  workspaces: WorkspaceService;
  clones: CloneJobs;
  pickFolder: (purpose: FolderPurpose) => Promise<string | null>;
  /** Detected and added CLIs; the saved custom ones only until detection is wired. */
  clis?: () => Promise<CliDefinition[]>;
  /** Runs after a workspace opens: its saved agents and free terminals come back (FR-038). */
  onOpened?: (workspaceId: string) => Promise<void>;
};

/** Main-process implementations of the app and workspace IPC channels. */
export function createAppServices({
  stores,
  workspaces,
  clones,
  pickFolder,
  clis,
  onOpened = () => Promise.resolve(),
}: Dependencies) {
  const opened = async (workspace: Workspace) => {
    await onOpened(workspace.id);
    return workspaces.get(workspace.id) ?? workspace;
  };
  return {
    async 'app:getState'(): Promise<IpcOutput<'app:getState'>> {
      const state = await stores.state.read();
      return {
        workspaces: workspaces.list(),
        recents: state.recents,
        clis: clis ? await clis() : state.customClis,
        permission: state.permission,
      };
    },
    'workspace:open': async ({ path }: { path: string }) => opened(await workspaces.open(path)),
    'workspace:initRepo': async ({ path }: { path: string }) =>
      opened(await workspaces.initRepo(path)),
    'workspace:close': ({ id }: { id: string }) => workspaces.close(id),
    'workspace:hasLocalChanges': ({ id }: { id: string }) => workspaces.hasLocalChanges(id),
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
