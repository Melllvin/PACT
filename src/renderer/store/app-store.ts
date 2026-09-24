import { createStore } from 'zustand/vanilla';
import {
  ipcErrorSchema,
  type IpcError,
  type IpcEvent,
  type IpcOutput,
  type PactApi,
} from '../../shared/ipc';
import type { Agent, Workspace } from '../../shared/model';

// research.md R10 — renderer state, fed by window.pact requests and events.

export type ActiveTab = { kind: 'home' } | { kind: 'workspace'; id: string };
export type View = 'tiles' | 'focus';
type AppSnapshot = IpcOutput<'app:getState'>;

export type AppState = {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  workspaces: Workspace[];
  recents: AppSnapshot['recents'];
  clis: AppSnapshot['clis'];
  permission: AppSnapshot['permission'];
  activeTab: ActiveTab;
  view: View;
  /** Last failed opening, kept with its path so the home screen can offer « Initialiser ». */
  openError: (IpcError & { path: string }) | null;
  clone: CloneStatus | null;
  cloneJobId: string | null;
  load: () => Promise<void>;
  /** Subscribes to main-process events; returns the function that unsubscribes. */
  connect: () => () => void;
  selectWorkspace: (id: string) => void;
  openHome: () => void;
  setView: (view: View) => void;
  openRepository: (path: string) => Promise<void>;
  initRepository: (path: string) => Promise<void>;
  pickRepository: () => Promise<void>;
  pickCloneDestination: () => Promise<string | null>;
  startClone: (url: string, destination: string) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
};

export type CloneStatus =
  { status: 'running'; percent: number; phase: string } | { status: 'failed'; message: string };

const asIpcError = (error: unknown): IpcError => {
  const parsed = ipcErrorSchema.safeParse(error);
  return parsed.success ? parsed.data : { code: 'INTERNAL', message: errorMessage(error) };
};

const errorMessage = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'message' in error &&
  typeof error.message === 'string'
    ? error.message
    : 'Erreur inattendue';

/** Returns `workspaces` unchanged (same reference) when no agent matches. */
function updateAgent(
  workspaces: Workspace[],
  agentId: string,
  update: (agent: Agent) => Agent,
): Workspace[] {
  const owner = workspaces.find((w) => w.agents.some((agent) => agent.id === agentId));
  if (!owner) return workspaces;
  return workspaces.map((workspace) =>
    workspace === owner
      ? {
          ...workspace,
          agents: workspace.agents.map((agent) => (agent.id === agentId ? update(agent) : agent)),
        }
      : workspace,
  );
}

const applyState =
  (event: IpcEvent<'agent:state'>) =>
  (agent: Agent): Agent => ({
    ...agent,
    state: event.state,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.scheduledResume === undefined ? {} : { scheduledResume: event.scheduledResume }),
  });

export function createAppStore(api: PactApi) {
  return createStore<AppState>()((set, get) => {
    /** Adds (or refreshes) a workspace and makes its tab active. */
    const addWorkspace = (workspace: Workspace) => {
      const others = get().workspaces.filter((w) => w.id !== workspace.id);
      set({
        workspaces: [...others, workspace],
        activeTab: { kind: 'workspace', id: workspace.id },
        openError: null,
      });
    };

    return {
      status: 'loading',
      error: null,
      workspaces: [],
      recents: [],
      clis: [],
      permission: null,
      activeTab: { kind: 'home' },
      view: 'tiles',
      openError: null,
      clone: null,
      cloneJobId: null,

      async load() {
        set({ status: 'loading', error: null });
        try {
          const snapshot = await api.invoke('app:getState');
          const first = snapshot.workspaces[0];
          set({
            ...snapshot,
            status: 'ready',
            activeTab: first ? { kind: 'workspace', id: first.id } : { kind: 'home' },
          });
        } catch (error) {
          set({ status: 'error', error: errorMessage(error) });
        }
      },

      connect() {
        const unsubscribers = [
          api.on('agent:state', (event) => {
            set({ workspaces: updateAgent(get().workspaces, event.agentId, applyState(event)) });
          }),
          api.on('agent:branch', ({ agentId, branch }) => {
            set({ workspaces: updateAgent(get().workspaces, agentId, (a) => ({ ...a, branch })) });
          }),
          api.on('workspace:status', ({ id, status }) => {
            set({ workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, status } : w)) });
          }),
          api.on('clone:progress', (event) => {
            if (event.jobId !== get().cloneJobId) return;
            if ('workspace' in event) {
              set({ clone: null, cloneJobId: null });
              addWorkspace(event.workspace);
            } else if ('error' in event) {
              set({ clone: { status: 'failed', message: event.error.message }, cloneJobId: null });
            } else {
              set({ clone: { status: 'running', percent: event.percent, phase: event.phase } });
            }
          }),
        ];
        return () => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        };
      },

      selectWorkspace(id) {
        if (get().workspaces.some((workspace) => workspace.id === id)) {
          set({ activeTab: { kind: 'workspace', id } });
        }
      },

      openHome() {
        set({ activeTab: { kind: 'home' } });
      },

      setView(view) {
        set({ view });
      },

      async openRepository(path) {
        try {
          addWorkspace(await api.invoke('workspace:open', { path }));
        } catch (error) {
          const failure = asIpcError(error);
          if (failure.code === 'ALREADY_OPEN' && failure.workspaceId) {
            set({ openError: null });
            get().selectWorkspace(failure.workspaceId);
          } else {
            set({ openError: { ...failure, path } });
          }
        }
      },

      async initRepository(path) {
        try {
          addWorkspace(await api.invoke('workspace:initRepo', { path }));
        } catch (error) {
          set({ openError: { ...asIpcError(error), path } });
        }
      },

      async pickRepository() {
        const path = await api.invoke('dialog:pickFolder', { purpose: 'open-repository' });
        if (path) await get().openRepository(path);
      },

      pickCloneDestination() {
        return api.invoke('dialog:pickFolder', { purpose: 'clone-destination' });
      },

      async startClone(url, destination) {
        set({ clone: { status: 'running', percent: 0, phase: 'Démarrage' } });
        try {
          const { jobId } = await api.invoke('workspace:clone', { url, destination });
          set({ cloneJobId: jobId });
        } catch (error) {
          set({ clone: { status: 'failed', message: asIpcError(error).message } });
        }
      },

      async closeWorkspace(id) {
        await api.invoke('workspace:close', { id });
        const remaining = get().workspaces.filter((w) => w.id !== id);
        const { activeTab } = get();
        const closedActive = activeTab.kind === 'workspace' && activeTab.id === id;
        const fallback = remaining.at(-1);
        set({
          workspaces: remaining,
          ...(closedActive
            ? { activeTab: fallback ? { kind: 'workspace', id: fallback.id } : { kind: 'home' } }
            : {}),
        });
      },
    };
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
