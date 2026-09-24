import {
  ipcErrorSchema,
  ipcEvents,
  ipcRequests,
  type IpcError,
  type IpcEventChannel,
  type IpcRequestChannel,
  type PactApi,
} from '../shared/ipc';

// Validated, channel-restricted bridge between the renderer and the main process (R11).

type Listener = (event: unknown, payload: unknown) => void;
type IpcRendererLike = {
  invoke(channel: string, input: unknown): Promise<unknown>;
  on(channel: string, listener: Listener): unknown;
  off(channel: string, listener: Listener): unknown;
};

const isRequestChannel = (channel: string): channel is IpcRequestChannel =>
  Object.hasOwn(ipcRequests, channel);

const invalid = (message: string): IpcError => ({ code: 'INVALID_INPUT', message });

type WebUtilsLike = { getPathForFile(file: File): string };

const noWebUtils: WebUtilsLike = {
  getPathForFile: () => '',
};

export function createPactApi(ipc: IpcRendererLike, webUtils: WebUtilsLike = noWebUtils): PactApi {
  const invoke = async (channel: string, input?: unknown): Promise<unknown> => {
    // Plain objects are rejected on purpose: contextBridge drops the custom properties (code)
    // of Error objects, and the renderer needs the code.
    /* eslint-disable @typescript-eslint/only-throw-error */
    if (!isRequestChannel(channel)) throw invalid(`Canal inconnu : ${channel}`);
    const parsed = ipcRequests[channel].input.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.message);

    const envelope = (await ipc.invoke(channel, parsed.data)) as
      { ok: true; data: unknown } | { ok: false; error: unknown };
    if (envelope.ok) return envelope.data;
    const error = ipcErrorSchema.safeParse(envelope.error);
    throw error.success ? error.data : { code: 'INTERNAL', message: 'Erreur inattendue' };
    /* eslint-enable @typescript-eslint/only-throw-error */
  };

  const on = (channel: IpcEventChannel, callback: (payload: unknown) => void) => {
    const listener: Listener = (_event, payload) => {
      const parsed = ipcEvents[channel].safeParse(payload);
      if (parsed.success) callback(parsed.data);
    };
    ipc.on(channel, listener);
    return () => {
      ipc.off(channel, listener);
    };
  };

  const pathForFile = (file: File) => webUtils.getPathForFile(file);

  return { invoke, on, pathForFile } as PactApi;
}
