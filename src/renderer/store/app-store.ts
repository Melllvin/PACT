import { createStore } from 'zustand/vanilla';
import {
  ipcErrorSchema,
  type IpcError,
  type IpcEvent,
  type IpcOutput,
  type AgentDraft,
  type PactApi,
} from '../../shared/ipc';
import type { Agent, PermissionLevel, PermissionPreference, Workspace } from '../../shared/model';

// research.md R10 — renderer state, fed by window.pact requests and events.

export type ActiveTab = { kind: 'home' } | { kind: 'workspace'; id: string };
export type View = 'tiles' | 'focus';
/** What the quick launcher (1c) asks for: agents per CLI id, plus free terminals. */
export type LaunchCounts = { agents: Record<string, number>; freeTerminal: number };
/** 1c, then 1m when no permission level is known yet (FR-012). */
export type Launcher =
  | { workspaceId: string; step: 'counts'; error?: string }
  | { workspaceId: string; step: 'permission'; counts: LaunchCounts };
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
  /** Workspace shown when the home tab was opened, to return to it on close. */
  previousWorkspaceId: string | null;
  launcher: Launcher | null;
  /** Why the last tile action was refused; cleared by the next one that succeeds. */
  actionError: string | null;
  /** « Journal » of an agent, as read from the main process. */
  log: { agentId: string; text: string } | null;
  /** Agent whose close dialog is open (FR-037). */
  closingAgentId: string | null;
  load: () => Promise<void>;
  /** Subscribes to main-process events; returns the function that unsubscribes. */
  connect: () => () => void;
  selectWorkspace: (id: string) => void;
  openHome: () => void;
  /** Leaves the home tab for the workspace shown before it (or the last one). */
  closeHome: () => void;
  setView: (view: View) => void;
  openRepository: (path: string) => Promise<void>;
  initRepository: (path: string) => Promise<void>;
  pickRepository: () => Promise<void>;
  pickCloneDestination: () => Promise<string | null>;
  startClone: (url: string, destination: string) => Promise<void>;
  closeWorkspace: (id: string) => Promise<void>;
  openLauncher: (workspaceId: string) => void;
  closeLauncher: () => void;
  /** Launches straight away when a level is known, otherwise asks for it first (1m). */
  requestLaunch: (counts: LaunchCounts) => Promise<void>;
  /** Saves the level chosen in 1m, then launches what 1c asked for. */
  confirmPermission: (choice: PermissionPreference) => Promise<void>;
  redetectClis: () => Promise<void>;
  /** `always`: « Toujours pour ce worktree » (FR-034). */
  answerAgent: (agentId: string, answer: 'allow' | 'deny', always?: boolean) => Promise<void>;
  resumeAgent: (agentId: string) => Promise<void>;
  restartAgent: (agentId: string) => Promise<void>;
  openLog: (agentId: string) => Promise<void>;
  closeLog: () => void;
  requestCloseAgent: (agentId: string) => void;
  cancelCloseAgent: () => void;
  /** Closes the agent asked for, keeping or removing its worktree and branch. */
  closeAgent: (removeWorktree: boolean) => Promise<void>;
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

/** Drops an agent from whichever workspace holds it. */
const withoutAgent = (workspaces: Workspace[], agentId: string): Workspace[] =>
  workspaces.map((workspace) =>
    workspace.agents.some((agent) => agent.id === agentId)
      ? { ...workspace, agents: workspace.agents.filter((agent) => agent.id !== agentId) }
      : workspace,
  );

export function createAppStore(api: PactApi) {
  return createStore<AppState>()((set, get) => {
    /** Adds (or refreshes) a workspace and makes its tab active. */
    /** Runs a tile action; a refusal is shown until an action succeeds. */
    const act = async (action: () => Promise<unknown>) => {
      try {
        await action();
        set({ actionError: null });
      } catch (error) {
        set({ actionError: asIpcError(error).message });
      }
    };

    const addWorkspace = (workspace: Workspace) => {
      const others = get().workspaces.filter((w) => w.id !== workspace.id);
      set({
        workspaces: [...others, workspace],
        activeTab: { kind: 'workspace', id: workspace.id },
        openError: null,
      });
    };

    /** Agents keep the level they were launched with; drafts leave the rest to the main process. */
    const drafts = (counts: LaunchCounts, level: PermissionLevel): AgentDraft[] =>
      Object.entries(counts.agents).flatMap(([cliId, count]) =>
        Array.from({ length: count }, () => ({
          cliId,
          model: null,
          permissionLevel: level,
          baseBranch: null,
          branch: null,
          port: null,
          startCommand: null,
        })),
      );

    const launch = async (workspaceId: string, counts: LaunchCounts, level: PermissionLevel) => {
      try {
        await api.invoke('agents:launch', {
          workspaceId,
          agents: drafts(counts, level),
          freeTerminals: counts.freeTerminal,
          // A zero for every installed CLI: the next launcher starts from exactly these (FR-010).
          counters: {
            freeTerminal: counts.freeTerminal,
            ...Object.fromEntries(
              get()
                .clis.filter((cli) => cli.status === 'installed')
                .map((cli) => [cli.id, 0]),
            ),
            ...counts.agents,
          },
        });
        // Only the workspaces: the rest of the snapshot may lag behind what was just chosen.
        const { workspaces } = await api.invoke('app:getState');
        set({ workspaces, launcher: null });
      } catch (error) {
        set({ launcher: { workspaceId, step: 'counts', error: asIpcError(error).message } });
      }
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
      previousWorkspaceId: null,
      launcher: null,
      actionError: null,
      log: null,
      closingAgentId: null,

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
            const { workspaces } = get();
            set({
              workspaces:
                event.state === 'closed'
                  ? withoutAgent(workspaces, event.agentId)
                  : updateAgent(workspaces, event.agentId, applyState(event)),
            });
          }),
          api.on('agent:branch', ({ agentId, branch }) => {
            set({ workspaces: updateAgent(get().workspaces, agentId, (a) => ({ ...a, branch })) });
          }),
          // Main drops a free terminal whose shell has exited; agents keep their tile (error).
          api.on('term:exit', ({ termId }) => {
            const { workspaces } = get();
            if (!workspaces.some((w) => w.freeTerminals.some((t) => t.id === termId))) return;
            set({
              workspaces: workspaces.map((w) => ({
                ...w,
                freeTerminals: w.freeTerminals.filter((t) => t.id !== termId),
              })),
            });
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
        const { activeTab } = get();
        set({
          activeTab: { kind: 'home' },
          previousWorkspaceId: activeTab.kind === 'workspace' ? activeTab.id : null,
        });
      },

      closeHome() {
        const { workspaces, previousWorkspaceId } = get();
        const target = workspaces.find((w) => w.id === previousWorkspaceId) ?? workspaces.at(-1);
        if (target) set({ activeTab: { kind: 'workspace', id: target.id } });
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

      openLauncher(workspaceId) {
        set({ launcher: { workspaceId, step: 'counts' } });
      },

      closeLauncher() {
        set({ launcher: null });
      },

      async requestLaunch(counts) {
        const { launcher, workspaces, permission } = get();
        if (!launcher) return;
        const { workspaceId } = launcher;
        const workspace = workspaces.find((w) => w.id === workspaceId);
        const level = workspace?.permissionOverride?.level ?? permission?.level;
        const hasAgents = Object.values(counts.agents).some((count) => count > 0);
        if (level) await launch(workspaceId, counts, level);
        // Free terminals alone run no agent: no permission to ask for.
        else if (!hasAgents) await launch(workspaceId, counts, 'always-ask');
        else set({ launcher: { workspaceId, step: 'permission', counts } });
      },

      async confirmPermission(choice) {
        const { launcher } = get();
        if (launcher?.step !== 'permission') return;
        const { workspaceId, counts } = launcher;
        const project = choice.scope === 'project';
        try {
          await api.invoke('permission:set', { ...choice, ...(project ? { workspaceId } : {}) });
        } catch (error) {
          set({ launcher: { workspaceId, step: 'counts', error: asIpcError(error).message } });
          return;
        }
        if (!project) set({ permission: choice });
        await launch(workspaceId, counts, choice.level);
      },

      async redetectClis() {
        set({ clis: await api.invoke('cli:redetect') });
      },

      answerAgent: (agentId, answer, always) =>
        act(() =>
          api.invoke('agent:answer', {
            agentId,
            answer,
            ...(always === undefined ? {} : { always }),
          }),
        ),
      resumeAgent: (agentId) => act(() => api.invoke('agent:resume', { agentId })),
      restartAgent: (agentId) => act(() => api.invoke('agent:restart', { agentId })),

      openLog: (agentId) =>
        act(async () => {
          set({ log: { agentId, text: await api.invoke('agent:log', { agentId }) } });
        }),

      closeLog() {
        set({ log: null });
      },

      requestCloseAgent(agentId) {
        set({ closingAgentId: agentId });
      },

      cancelCloseAgent() {
        set({ closingAgentId: null });
      },

      async closeAgent(removeWorktree) {
        const agentId = get().closingAgentId;
        if (agentId === null) return;
        set({ closingAgentId: null });
        await act(async () => {
          await api.invoke('agent:close', { agentId, removeWorktree });
          set({ workspaces: withoutAgent(get().workspaces, agentId) });
        });
      },
    };
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
