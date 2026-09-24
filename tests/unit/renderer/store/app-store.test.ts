import { describe, expect, it, vi } from 'vitest';
import type { IpcEvent, IpcEventChannel, IpcOutput, PactApi } from '../../../../src/shared/ipc';
import type { Agent, Workspace } from '../../../../src/shared/model';
import { createAppStore } from '../../../../src/renderer/store/app-store';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/fake-${String(n)}`,
  worktreePath: `/repo/.worktrees/fake-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'starting',
  lastError: null,
  scheduledResume: null,
  ...overrides,
});

const workspace = (id: string, agents: Agent[] = []): Workspace => ({
  id,
  path: `/${id}`,
  name: id,
  mainBranch: 'main',
  agents,
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

function fakeApi(state: Partial<IpcOutput<'app:getState'>> = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn(() =>
    Promise.resolve({ workspaces: [], recents: [], clis: [], permission: null, ...state }),
  );
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
  } as unknown as PactApi;
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  const listenerCount = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { api, invoke, emit, listenerCount };
}

describe('app store', () => {
  it('starts loading, then holds the state returned by the main process', async () => {
    const { api } = fakeApi({ workspaces: [workspace('w1')] });
    const store = createAppStore(api);
    expect(store.getState().status).toBe('loading');
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'ready', workspaces: [{ id: 'w1' }] });
  });

  it('opens on the first workspace, or on the home tab when none is open', async () => {
    const withWorkspace = createAppStore(
      fakeApi({ workspaces: [workspace('w1'), workspace('w2')] }).api,
    );
    await withWorkspace.getState().load();
    expect(withWorkspace.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });

    const empty = createAppStore(fakeApi().api);
    await empty.getState().load();
    expect(empty.getState().activeTab).toEqual({ kind: 'home' });
  });

  it('reports a failed load with a displayable message', async () => {
    const { api, invoke } = fakeApi();
    invoke.mockRejectedValueOnce({ code: 'INTERNAL', message: 'Disque illisible' });
    const store = createAppStore(api);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ status: 'error', error: 'Disque illisible' });
  });

  it('switches tabs and opens the home tab with « + »', async () => {
    const store = createAppStore(fakeApi({ workspaces: [workspace('w1'), workspace('w2')] }).api);
    await store.getState().load();
    store.getState().selectWorkspace('w2');
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w2' });
    store.getState().openHome();
    expect(store.getState().activeTab).toEqual({ kind: 'home' });
  });

  it('ignores a tab selection for an unknown workspace', async () => {
    const store = createAppStore(fakeApi({ workspaces: [workspace('w1')] }).api);
    await store.getState().load();
    store.getState().selectWorkspace('nope');
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });
  });

  it('tracks the active view', () => {
    const store = createAppStore(fakeApi().api);
    expect(store.getState().view).toBe('tiles');
    store.getState().setView('focus');
    expect(store.getState().view).toBe('focus');
  });

  it('applies agent state, branch and workspace status events', async () => {
    const { api, emit } = fakeApi({ workspaces: [workspace('w1', [agent(1), agent(2)])] });
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();

    emit('agent:state', {
      agentId: uuid(2),
      state: 'error',
      lastError: { code: 1, kind: 'crash', message: 'Erreur' },
    });
    emit('agent:branch', { agentId: uuid(1), branch: 'feature/login' });
    emit('workspace:status', { id: 'w1', status: 'unavailable' });

    const [ws] = store.getState().workspaces;
    expect(ws?.status).toBe('unavailable');
    expect(ws?.agents[0]?.branch).toBe('feature/login');
    expect(ws?.agents[1]).toMatchObject({
      state: 'error',
      lastError: { code: 1, kind: 'crash', message: 'Erreur' },
    });
    expect(ws?.agents[0]?.state).toBe('starting');
  });

  it('ignores events about unknown agents', async () => {
    const { api, emit } = fakeApi({ workspaces: [workspace('w1', [agent(1)])] });
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();
    const before = store.getState().workspaces;
    emit('agent:state', { agentId: uuid(9), state: 'done' });
    expect(store.getState().workspaces).toBe(before);
  });

  it('stops listening once disconnected', () => {
    const { api, listenerCount } = fakeApi();
    const store = createAppStore(api);
    const disconnect = store.getState().connect();
    expect(listenerCount()).toBeGreaterThan(0);
    disconnect();
    expect(listenerCount()).toBe(0);
  });
});
