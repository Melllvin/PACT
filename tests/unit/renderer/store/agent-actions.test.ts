import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import type { Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// US3 — the tile actions in the store: answer, resume, restart, « Journal », closing (T074, T078).

type Invoke = (channel: string, input?: unknown) => Promise<unknown>;

const workspace: Workspace = {
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [agent(1, { state: 'error' }), agent(2)],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
};

// Another open workspace, untouched by what happens to the agents of the first one.
const other: Workspace = { ...workspace, id: 'w2', path: '/w2', name: 'w2', agents: [agent(3)] };

const setup = async (fail?: string) => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn<Invoke>((channel) => {
    if (channel === 'app:getState') {
      return Promise.resolve({
        workspaces: [workspace, other],
        recents: [],
        clis: [],
        permission: null,
      });
    }
    // IPC failures reach the renderer as plain { code, message } objects.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (channel === fail) return Promise.reject({ code: 'INVALID_INPUT', message: 'Refusé' });
    if (channel === 'agent:log') return Promise.resolve('Erreur simulée');
    return Promise.resolve(undefined);
  });
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  } as unknown as PactApi;
  const store = createAppStore(api);
  store.getState().connect();
  await store.getState().load();
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    listeners.get(channel)?.(payload);
  };
  return { store, invoke, emit };
};

const id = agent(1).id;

describe('agent actions', () => {
  it('sends the answer, « Reprendre » and « Relancer » to the main process', async () => {
    const { store, invoke } = await setup();
    await store.getState().answerAgent(id, 'allow');
    await store.getState().resumeAgent(id);
    await store.getState().restartAgent(id);
    expect(invoke).toHaveBeenCalledWith('agent:answer', { agentId: id, answer: 'allow' });
    expect(invoke).toHaveBeenCalledWith('agent:resume', { agentId: id });
    expect(invoke).toHaveBeenCalledWith('agent:restart', { agentId: id });
    expect(store.getState().actionError).toBeNull();
  });

  it('shows a refused action until the next one succeeds', async () => {
    const { store } = await setup('agent:resume');
    await store.getState().resumeAgent(id);
    expect(store.getState().actionError).toBe('Refusé');
    await store.getState().restartAgent(id);
    expect(store.getState().actionError).toBeNull();
  });

  it('opens and closes « Journal » with the output kept by the main process', async () => {
    const { store, invoke } = await setup();
    await store.getState().openLog(id);
    expect(invoke).toHaveBeenCalledWith('agent:log', { agentId: id });
    expect(store.getState().log).toEqual({ agentId: id, text: 'Erreur simulée' });
    store.getState().closeLog();
    expect(store.getState().log).toBeNull();
  });

  it('reports a « Journal » that cannot be read', async () => {
    const { store } = await setup('agent:log');
    await store.getState().openLog(id);
    expect(store.getState().log).toBeNull();
    expect(store.getState().actionError).toBe('Refusé');
  });
});

describe('closing an agent (FR-037)', () => {
  it('asks first, then closes with the choice made and drops the tile', async () => {
    const { store, invoke } = await setup();
    store.getState().requestCloseAgent(id);
    expect(store.getState().closingAgentId).toBe(id);
    await store.getState().closeAgent(true);
    expect(invoke).toHaveBeenCalledWith('agent:close', { agentId: id, removeWorktree: true });
    expect(store.getState().closingAgentId).toBeNull();
    expect(store.getState().workspaces[0]?.agents.map((a) => a.id)).toEqual([agent(2).id]);
  });

  it('can be cancelled, and does nothing when no close was asked', async () => {
    const { store, invoke } = await setup();
    store.getState().requestCloseAgent(id);
    store.getState().cancelCloseAgent();
    await store.getState().closeAgent(false);
    expect(invoke).not.toHaveBeenCalledWith('agent:close', expect.anything());
  });

  it('keeps the tile and shows why when the close fails', async () => {
    const { store } = await setup('agent:close');
    store.getState().requestCloseAgent(id);
    await store.getState().closeAgent(false);
    expect(store.getState().workspaces[0]?.agents).toHaveLength(2);
    expect(store.getState().closingAgentId).toBeNull();
    expect(store.getState().actionError).toBe('Refusé');
  });

  it('drops the tile of an agent announced closed', async () => {
    const { store, emit } = await setup();
    emit('agent:state', { agentId: agent(2).id, state: 'closed' });
    expect(store.getState().workspaces[0]?.agents.map((a) => a.id)).toEqual([id]);
    expect(store.getState().workspaces[1]).toEqual(other);
  });
});
