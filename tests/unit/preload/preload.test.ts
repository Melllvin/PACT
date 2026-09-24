import { describe, expect, it, vi } from 'vitest';
import { createPactApi } from '../../../src/preload/api';

const agentId = '00000000-0000-4000-8000-000000000001';

const fakeIpcRenderer = () => {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  return {
    invoke: vi.fn<(channel: string, input: unknown) => Promise<unknown>>(),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
    }),
    off: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
};

describe('window.pact.pathForFile', () => {
  it('resolves a dropped file to its path through webUtils', () => {
    const getPathForFile = vi.fn(() => '/Users/me/depot');
    const api = createPactApi(fakeIpcRenderer(), { getPathForFile });
    const file = new File([''], 'depot');
    expect(api.pathForFile(file)).toBe('/Users/me/depot');
    expect(getPathForFile).toHaveBeenCalledWith(file);
  });
});

describe('window.pact', () => {
  it('is exposed by the preload through the context bridge', async () => {
    const exposeInMainWorld = vi.fn();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: fakeIpcRenderer(),
      webUtils: { getPathForFile: vi.fn() },
    }));
    await import('../../../src/preload/index');
    expect(exposeInMainWorld).toHaveBeenCalledWith(
      'pact',
      expect.objectContaining({
        invoke: expect.any(Function) as unknown,
        on: expect.any(Function) as unknown,
      }),
    );
    vi.doUnmock('electron');
  });

  it('invokes a channel and unwraps the result', async () => {
    const ipc = fakeIpcRenderer();
    ipc.invoke.mockResolvedValue({ ok: true, data: 'journal' });
    const api = createPactApi(ipc, { getPathForFile: () => '' });
    expect(await api.invoke('agent:log', { agentId })).toBe('journal');
    expect(ipc.invoke).toHaveBeenCalledWith('agent:log', { agentId });
  });

  it('rejects an invalid input before it reaches the main process', async () => {
    const ipc = fakeIpcRenderer();
    const api = createPactApi(ipc, { getPathForFile: () => '' });
    await expect(api.invoke('agent:log', { agentId: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  // contextBridge drops custom properties of Error objects, so errors cross it as plain objects.
  it('rejects with a plain { code, message } object that survives the context bridge', async () => {
    const ipc = fakeIpcRenderer();
    ipc.invoke.mockResolvedValue({
      ok: false,
      error: { code: 'ALREADY_OPEN', message: 'Déjà ouvert', workspaceId: 'w1' },
    });
    const error = await createPactApi(ipc, { getPathForFile: () => '' })
      .invoke('workspace:open', { path: '/repo' })
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(Error);
    expect(error).toEqual({
      code: 'ALREADY_OPEN',
      message: 'Déjà ouvert',
      workspaceId: 'w1',
    });
  });

  it('refuses channels outside the contract', async () => {
    const ipc = fakeIpcRenderer();
    const api = createPactApi(ipc, { getPathForFile: () => '' }) as unknown as {
      invoke(c: string, i: unknown): Promise<unknown>;
    };
    await expect(api.invoke('fs:readFile', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('delivers valid events, drops invalid ones and unsubscribes', () => {
    const ipc = fakeIpcRenderer();
    const api = createPactApi(ipc, { getPathForFile: () => '' });
    const received = vi.fn();
    const off = api.on('agent:branch', received);

    ipc.emit('agent:branch', { agentId, branch: 'feature/x' });
    ipc.emit('agent:branch', { agentId, branch: 42 });
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ agentId, branch: 'feature/x' });

    off();
    ipc.emit('agent:branch', { agentId, branch: 'again' });
    expect(received).toHaveBeenCalledTimes(1);
  });
});
