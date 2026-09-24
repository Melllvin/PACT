import { describe, expect, it, vi } from 'vitest';
import { createEventEmitter, registerHandlers } from '../../../../src/main/ipc/handlers';

type Listener = (event: { senderFrame: { url: string } | null }, input: unknown) => unknown;

const fakeIpcMain = () => {
  const handlers = new Map<string, Listener>();
  return {
    handlers,
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    call: (channel: string, input: unknown, url = 'file:///app/index.html') => {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler for ${channel}`);
      return listener({ senderFrame: { url } }, input);
    },
  };
};

const trusted = (url: string) => url.startsWith('file://');
const agentId = '00000000-0000-4000-8000-000000000001';

describe('registerHandlers', () => {
  it('only registers the channels that have an implementation', () => {
    const ipc = fakeIpcMain();
    registerHandlers(ipc, { 'agent:log': () => 'log' }, { isTrustedSender: trusted });
    expect([...ipc.handlers.keys()]).toEqual(['agent:log']);
  });

  it('passes the validated input to the service and wraps its result', async () => {
    const ipc = fakeIpcMain();
    const log = vi.fn(() => 'full log');
    registerHandlers(ipc, { 'agent:log': log }, { isTrustedSender: trusted });
    expect(await ipc.call('agent:log', { agentId })).toEqual({ ok: true, data: 'full log' });
    expect(log).toHaveBeenCalledWith({ agentId });
  });

  it('rejects an invalid input without calling the service', async () => {
    const ipc = fakeIpcMain();
    const log = vi.fn(() => 'x');
    registerHandlers(ipc, { 'agent:log': log }, { isTrustedSender: trusted });
    const result = (await ipc.call('agent:log', { agentId: 'not-a-uuid' })) as {
      ok: false;
      error: { code: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(log).not.toHaveBeenCalled();
  });

  it('returns normalized errors thrown by the service', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(
      ipc,
      {
        'workspace:close': () => {
          throw { code: 'NOT_FOUND', message: 'Workspace inconnu' };
        },
        'agent:resume': () => {
          throw new Error('pty crashed');
        },
      },
      { isTrustedSender: trusted },
    );
    expect(await ipc.call('workspace:close', { id: 'w1' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Workspace inconnu' },
    });
    expect(await ipc.call('agent:resume', { agentId })).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'pty crashed' },
    });
  });

  it('never returns an output that violates the contract', async () => {
    const ipc = fakeIpcMain();
    registerHandlers(
      ipc,
      { 'agent:log': () => 42 as unknown as string },
      { isTrustedSender: trusted },
    );
    const result = (await ipc.call('agent:log', { agentId })) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });

  it('refuses calls from an untrusted frame', async () => {
    const ipc = fakeIpcMain();
    const log = vi.fn(() => 'x');
    registerHandlers(ipc, { 'agent:log': log }, { isTrustedSender: trusted });
    const result = (await ipc.call('agent:log', { agentId }, 'https://evil.example')) as {
      ok: boolean;
      error: { code: string };
    };
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('createEventEmitter', () => {
  it('validates the payload and sends it to every window', () => {
    const windows = [{ send: vi.fn() }, { send: vi.fn() }];
    const emit = createEventEmitter(() => windows);
    emit('agent:branch', { agentId, branch: 'feature/x' });
    for (const win of windows) {
      expect(win.send).toHaveBeenCalledWith('agent:branch', { agentId, branch: 'feature/x' });
    }
  });

  it('refuses to send a payload that violates the contract', () => {
    const windows = [{ send: vi.fn() }];
    const emit = createEventEmitter(() => windows);
    expect(() => {
      emit('agent:branch', { agentId, branch: 42 } as unknown as {
        agentId: string;
        branch: string;
      });
    }).toThrow();
    expect(windows[0]?.send).not.toHaveBeenCalled();
  });
});
