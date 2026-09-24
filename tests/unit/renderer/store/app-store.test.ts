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

  it('closes the home tab back to the workspace shown before it', async () => {
    const store = createAppStore(fakeApi({ workspaces: [workspace('w1'), workspace('w2')] }).api);
    await store.getState().load();
    store.getState().selectWorkspace('w2');
    store.getState().openHome();
    store.getState().closeHome();
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w2' });
  });

  it('closes the home tab to the last workspace when the previous one is gone', () => {
    const store = createAppStore(fakeApi().api);
    store.setState({ workspaces: [workspace('w1')], activeTab: { kind: 'home' } });
    store.getState().closeHome();
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });
  });

  it('keeps the home tab when no workspace is open', () => {
    const store = createAppStore(fakeApi().api);
    store.getState().closeHome();
    expect(store.getState().activeTab).toEqual({ kind: 'home' });
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

  it('removes a free terminal whose shell has exited, and nothing for an agent', async () => {
    const shell = { id: uuid(7), workspaceId: 'w1', cwd: '/w1', shell: '/bin/zsh' };
    const { api, emit } = fakeApi({
      workspaces: [{ ...workspace('w1', [agent(1)]), freeTerminals: [shell] }],
    });
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();
    const before = store.getState().workspaces;
    emit('term:exit', { termId: uuid(1), code: 0 });
    expect(store.getState().workspaces).toBe(before);
    emit('term:exit', { termId: uuid(7), code: 0 });
    expect(store.getState().workspaces[0]?.freeTerminals).toEqual([]);
    expect(store.getState().workspaces[0]?.agents).toHaveLength(1);
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

describe('US1 actions', () => {
  type Invoke = (channel: string, input?: unknown) => Promise<unknown>;
  const setup = (handlers: Record<string, (input: unknown) => unknown>) => {
    const { api, emit } = fakeApi();
    const invoke = vi.fn<Invoke>((channel, input) => {
      if (channel === 'app:getState') {
        return Promise.resolve({ workspaces: [], recents: [], clis: [], permission: null });
      }
      const handler = handlers[channel];
      return handler
        ? Promise.resolve().then(() => handler(input))
        : Promise.reject(new Error(channel));
    });
    (api as unknown as { invoke: Invoke }).invoke = invoke;
    const store = createAppStore(api);
    store.getState().connect();
    return { store, invoke, emit };
  };

  it('opens a repository and selects its new tab', async () => {
    const { store } = setup({ 'workspace:open': () => workspace('w1') });
    await store.getState().load();
    await store.getState().openRepository('/w1');
    expect(store.getState().workspaces.map((w) => w.id)).toEqual(['w1']);
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });
    expect(store.getState().openError).toBeNull();
  });

  it('switches to the existing tab when the repository is already open (FR-004)', async () => {
    const { store } = setup({
      'workspace:open': () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the preload rejects plain objects (contextBridge)
        throw { code: 'ALREADY_OPEN', message: 'Déjà ouvert', workspaceId: 'w1' };
      },
    });
    store.setState({ workspaces: [workspace('w1')], activeTab: { kind: 'home' } });
    await store.getState().openRepository('/w1');
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });
    expect(store.getState().openError).toBeNull();
  });

  it('keeps the refused path so the home screen can offer to initialize it', async () => {
    const { store } = setup({
      'workspace:open': () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the preload rejects plain objects (contextBridge)
        throw { code: 'NOT_A_REPO', message: '« notes » n’est pas un dépôt Git.' };
      },
    });
    await store.getState().openRepository('/notes');
    expect(store.getState().openError).toEqual({
      code: 'NOT_A_REPO',
      message: '« notes » n’est pas un dépôt Git.',
      path: '/notes',
    });
    expect(store.getState().activeTab).toEqual({ kind: 'home' });
  });

  it('initializes a repository and opens it', async () => {
    const { store, invoke } = setup({ 'workspace:initRepo': () => workspace('w2') });
    store.setState({ openError: { code: 'NOT_A_REPO', message: 'x', path: '/w2' } });
    await store.getState().initRepository('/w2');
    expect(invoke).toHaveBeenCalledWith('workspace:initRepo', { path: '/w2' });
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w2' });
    expect(store.getState().openError).toBeNull();
  });

  it('opens the folder chosen in the native picker, and nothing when cancelled', async () => {
    const picked: (string | null)[] = ['/w1', null];
    const { store, invoke } = setup({
      'dialog:pickFolder': () => picked.shift(),
      'workspace:open': () => workspace('w1'),
    });
    await store.getState().pickRepository();
    expect(invoke).toHaveBeenCalledWith('dialog:pickFolder', { purpose: 'open-repository' });
    expect(store.getState().workspaces).toHaveLength(1);
    await store.getState().pickRepository();
    expect(invoke.mock.calls.filter(([c]) => c === 'workspace:open')).toHaveLength(1);
  });

  it('asks for a clone destination', async () => {
    const { store, invoke } = setup({ 'dialog:pickFolder': () => '/dest' });
    expect(await store.getState().pickCloneDestination()).toBe('/dest');
    expect(invoke).toHaveBeenCalledWith('dialog:pickFolder', { purpose: 'clone-destination' });
  });

  it('follows a clone from progress to the opened workspace', async () => {
    const { store, emit } = setup({ 'workspace:clone': () => ({ jobId: 'j1' }) });
    await store.getState().startClone('git@x:y.git', '/dest');
    expect(store.getState().clone).toEqual({ status: 'running', percent: 0, phase: 'Démarrage' });

    emit('clone:progress', { jobId: 'other', percent: 90, phase: 'x' });
    expect(store.getState().clone).toMatchObject({ percent: 0 });
    emit('clone:progress', { jobId: 'j1', percent: 42, phase: 'Réception d’objets' });
    expect(store.getState().clone).toEqual({
      status: 'running',
      percent: 42,
      phase: 'Réception d’objets',
    });
    emit('clone:progress', { jobId: 'j1', workspace: workspace('w9') });
    expect(store.getState().clone).toBeNull();
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w9' });
  });

  it('keeps the path when initializing a repository fails', async () => {
    const { store } = setup({
      'workspace:initRepo': () => {
        throw new Error('Permission refusée');
      },
    });
    await store.getState().initRepository('/locked');
    expect(store.getState().openError).toEqual({
      code: 'INTERNAL',
      message: 'Permission refusée',
      path: '/locked',
    });
  });

  it('reports a clone that cannot start', async () => {
    const { store } = setup({
      'workspace:clone': () => {
        throw new Error('Destination invalide');
      },
    });
    await store.getState().startClone('x', '/dest');
    expect(store.getState().clone).toEqual({ status: 'failed', message: 'Destination invalide' });
  });

  it('reports a failed clone', async () => {
    const { store, emit } = setup({ 'workspace:clone': () => ({ jobId: 'j1' }) });
    await store.getState().startClone('bad', '/dest');
    emit('clone:progress', { jobId: 'j1', error: { code: 'CLONE_FAILED', message: 'Not found' } });
    expect(store.getState().clone).toEqual({ status: 'failed', message: 'Not found' });
  });

  it('closes a workspace tab and falls back to another tab or home', async () => {
    const { store, invoke } = setup({ 'workspace:close': () => undefined });
    store.setState({
      workspaces: [workspace('w1'), workspace('w2')],
      activeTab: { kind: 'workspace', id: 'w2' },
    });
    await store.getState().closeWorkspace('w2');
    expect(invoke).toHaveBeenCalledWith('workspace:close', { id: 'w2' });
    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w1' });
    await store.getState().closeWorkspace('w1');
    expect(store.getState().activeTab).toEqual({ kind: 'home' });
    expect(store.getState().workspaces).toEqual([]);
  });
});
