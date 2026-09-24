import { createStore } from 'zustand/vanilla';
import type { IpcEvent, IpcOutput, PactApi } from '../../shared/ipc';
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
  load(): Promise<void>;
  /** Subscribes to main-process events; returns the function that unsubscribes. */
  connect(): () => void;
  selectWorkspace(id: string): void;
  openHome(): void;
  setView(view: View): void;
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
  return createStore<AppState>()((set, get) => ({
    status: 'loading',
    error: null,
    workspaces: [],
    recents: [],
    clis: [],
    permission: null,
    activeTab: { kind: 'home' },
    view: 'tiles',

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
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
