import { fileURLToPath } from 'node:url';
import type { IpcOutput } from '../shared/ipc';
import type { Stores } from './persistence/store';

/**
 * Main-process implementations of the IPC channels available so far. Workspace restoration,
 * CLI detection and agents join app:getState with US1 and US2 (T043, T045, T060).
 */
export function createAppServices({ stores }: { stores: Stores }) {
  return {
    async 'app:getState'(): Promise<IpcOutput<'app:getState'>> {
      const state = await stores.state.read();
      return {
        workspaces: [],
        recents: state.recents,
        clis: state.customClis,
        permission: state.permission,
      };
    },
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
