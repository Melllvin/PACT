import { contextBridge, ipcRenderer, webUtils } from 'electron';
const api = {
  invoke: (channel: string, input?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, input),
  on: (channel: string, callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
};
contextBridge.exposeInMainWorld('pact', api);
export type PactApi = typeof api;
declare global {
  interface Window {
    pact: PactApi;
  }
}
