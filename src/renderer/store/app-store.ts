import { createStore } from 'zustand/vanilla';
import {
  ipcErrorSchema,
  type IpcError,
  type IpcEvent,
  type IpcOutput,
  type PactApi,
} from '../../shared/ipc';
import { countsOf, toAgentDrafts, type LaunchDraft } from '../../shared/launch-draft';
import type {
  Agent,
  PermissionLevel,
  PermissionPreference,
  Role,
  RoleProfile,
  Workspace,
} from '../../shared/model';
import type { OrchestratorAction } from '../../shared/orchestrator';
import {
  DEFAULT_USAGE_THRESHOLDS,
  type UsageState,
  type UsageThresholds,
} from '../../shared/usage';

// research.md R10 — renderer state, fed by window.pact requests and events.

/** 004 US2 — a report, a missing one, the end of a loop, as the « Rapports » band shows it. */
export type LoopReport = {
  agentId: string;
  kind: 'report' | 'report-missing' | 'loop' | 'publish' | 'mockup';
  summary: string;
  at: string;
};

export type ActiveTab = { kind: 'home' } | { kind: 'workspace'; id: string };
export type View = 'tiles' | 'focus';
/**
 * 1c or 1d, then 1m when no permission level is known yet (FR-012). The draft goes along, so a
 * refused launch or a failed choice brings the launcher back as it was.
 */
export type Launcher =
  | {
      workspaceId: string;
      step: 'counts';
      draft?: LaunchDraft;
      error?: string;
      /** The repository has uncommitted changes, which the worktrees leave out (T122). */
      localChanges?: boolean;
    }
  | { workspaceId: string; step: 'permission'; draft: LaunchDraft };
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
  /** 005 — the usage of each CLI account, by `<cliId>\0<account>`. */
  usage: Record<string, UsageState>;
  /** 005 FR-010 — the alert thresholds of the gauges. */
  usageThresholds: UsageThresholds;
  setUsageThresholds: (thresholds: UsageThresholds) => Promise<void>;
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
  requestLaunch: (draft: LaunchDraft) => Promise<void>;
  /** Saves the level chosen in 1m, then launches what 1c asked for. */
  confirmPermission: (choice: PermissionPreference) => Promise<void>;
  redetectClis: () => Promise<void>;
  /** « Autre CLI — ajouter »; resolves with why it was refused, or null (FR-008). */
  addCli: (name: string, command: string) => Promise<string | null>;
  /** `always`: « Toujours pour ce worktree » (FR-034). */
  answerAgent: (agentId: string, answer: 'allow' | 'deny', always?: boolean) => Promise<void>;
  resumeAgent: (agentId: string) => Promise<void>;
  restartAgent: (agentId: string) => Promise<void>;
  /** « Annuler » of « reprise auto à HH:MM » (FR-036). */
  cancelAutoResume: (agentId: string) => Promise<void>;
  /** 003 US3 — the user's answer to an integration the orchestrator asks for (FR-018). */
  confirmIntegrationRequest: (requestId: string, message: string) => Promise<void>;
  refuseIntegrationRequest: (requestId: string) => Promise<void>;
  /** 003 US5 — the journal « ◎ Actions » of an orchestrator, the latest first (FR-021). */
  orchestratorActions: Record<string, OrchestratorAction[]>;
  loadOrchestratorActions: (agentId: string) => Promise<void>;
  /** « Retirer le rôle d'orchestrateur » (FR-004): the agent stays, as an ordinary one. */
  revokeOrchestrator: (agentId: string) => Promise<void>;
  /** 004 US2 — what the loops told, by workspace, the latest last (« Rapports »). */
  loopReports: Record<string, LoopReport[]>;
  /** 004 FR-018 — the user's decision on a loop stopped after 3 rounds. */
  decideLoop: (
    workspaceId: string,
    issueId: string,
    decision: 'restart' | 'take-over' | 'abandon',
  ) => Promise<void>;
  /** 004 FR-023 — « Créer » / « Refuser » of the issues the orchestrator asks to publish. */
  confirmPublish: (requestId: string) => Promise<void>;
  refusePublish: (requestId: string) => Promise<void>;
  /** 004 US1 — the role profiles of a workspace, shown at once and saved (FR-003). */
  setRoleProfiles: (
    workspaceId: string,
    profiles: Partial<Record<Role, RoleProfile>>,
  ) => Promise<void>;
  openLog: (agentId: string) => Promise<void>;
  closeLog: () => void;
  requestCloseAgent: (agentId: string) => void;
  cancelCloseAgent: () => void;
  /** Closes the agent asked for, keeping or removing its worktree and branch. */
  closeAgent: (removeWorktree: boolean) => Promise<void>;
  /** « vu » of a file in the review: the content seen, or `null` to forget it (002 FR-009). */
  markSeen: (agentId: string, path: string, blob: string | null) => Promise<void>;
  /** A comment on one line of the diff, sent to the agent (002 FR-012). */
  commentLine: (agentId: string, path: string, line: number, text: string) => Promise<void>;
  /** A shortcut above the terminal, or « Renvoyer à l'agent » with its text (FR-013, FR-015). */
  sendToAgent: (agentId: string, kind: ReviewSendKind, text?: string) => Promise<void>;
  /**
   * The agents the review sent a prompt to: `queued` until they start on it, `working` until
   * they are ready again (« Agent : correction en cours »).
   */
  correcting: Record<string, 'queued' | 'working'>;
  /** 003 FR-010 — the agents on a prompt of the orchestrator, followed the same way. */
  orchestratorPrompted: Record<string, 'queued' | 'working'>;
};

export type ReviewSendKind = 'fix-comments' | 'failing-tests' | 'conflict' | 'request';

export type CloneStatus =
  { status: 'running'; percent: number; phase: string } | { status: 'failed'; message: string };

/** As the main process keeps them (FR-021). */
const MAX_ACTIONS = 200;
const MAX_LOOP_REPORTS = 50;

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
  ({ awaiting: _previous, ...agent }: Agent): Agent => ({
    ...agent,
    state: event.state,
    ...(event.lastError === undefined ? {} : { lastError: event.lastError }),
    ...(event.scheduledResume === undefined ? {} : { scheduledResume: event.scheduledResume }),
    // Each event tells whether the agent asks a question: absent, it does not (FR-024a).
    ...(event.awaiting === undefined ? {} : { awaiting: event.awaiting }),
  });

/** `queued` → `working` once the agent works on the prompt, then dropped once it is ready. */
function followCorrection(
  correcting: AppState['correcting'],
  { agentId, state }: IpcEvent<'agent:state'>,
): AppState['correcting'] {
  const current = correcting[agentId];
  if (current === undefined) return correcting;
  if (state === 'working') return { ...correcting, [agentId]: 'working' };
  if (current === 'working' || state === 'closed' || state === 'error') {
    return Object.fromEntries(Object.entries(correcting).filter(([id]) => id !== agentId));
  }
  return correcting;
}

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

    const launch = async (workspaceId: string, draft: LaunchDraft, level: PermissionLevel) => {
      const counts = countsOf(draft);
      try {
        await api.invoke('agents:launch', {
          workspaceId,
          // Agents keep the level they were launched with (FR-012).
          agents: toAgentDrafts(
            draft,
            level,
            (cliId) => get().clis.find((cli) => cli.id === cliId)?.models ?? [],
          ),
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
        set({ launcher: { workspaceId, step: 'counts', draft, error: asIpcError(error).message } });
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
      usage: {},
      usageThresholds: DEFAULT_USAGE_THRESHOLDS,
      correcting: {},
      orchestratorPrompted: {},
      orchestratorActions: {},
      loopReports: {},

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
          // 005 — the gauges come later, without holding the window back.
          void Promise.resolve()
            .then(() => api.invoke('usage:get'))
            .then((states) => {
              set({ usage: { ...byAccount(states), ...get().usage } });
            })
            .catch(() => undefined);
        } catch (error) {
          set({ status: 'error', error: errorMessage(error) });
        }
      },

      connect() {
        const unsubscribers = [
          api.on('usage:state', (state) => {
            set({ usage: { ...get().usage, ...byAccount([state]) } });
          }),
          api.on('agent:state', (event) => {
            const { workspaces } = get();
            set({
              workspaces:
                event.state === 'closed'
                  ? withoutAgent(workspaces, event.agentId)
                  : updateAgent(workspaces, event.agentId, applyState(event)),
              correcting: followCorrection(get().correcting, event),
              orchestratorPrompted: followCorrection(get().orchestratorPrompted, event),
            });
          }),
          api.on('orchestrator:prompted', ({ agentId }) => {
            set({ orchestratorPrompted: { ...get().orchestratorPrompted, [agentId]: 'queued' } });
          }),
          // 003 FR-015 — agents launched by an orchestrator: their tiles appear too.
          api.on('workspace:agentsLaunched', () => {
            void api
              .invoke('app:getState')
              .then(({ workspaces }) => {
                set({ workspaces });
              })
              .catch(() => undefined);
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
          api.on('orchestrator:action', ({ orchestratorId, ...action }) => {
            const journal = get().orchestratorActions[orchestratorId] ?? [];
            set({
              orchestratorActions: {
                ...get().orchestratorActions,
                [orchestratorId]: [action, ...journal].slice(0, MAX_ACTIONS),
              },
            });
          }),
          api.on('workspace:integrationRequests', ({ workspaceId, requests }) => {
            set({
              workspaces: get().workspaces.map((w) =>
                w.id === workspaceId ? { ...w, integrationRequests: requests } : w,
              ),
            });
          }),
          api.on('workspace:loops', ({ workspaceId, loops, issues }) => {
            set({
              workspaces: get().workspaces.map((w) =>
                w.id === workspaceId ? { ...w, loops, issues } : w,
              ),
            });
          }),
          api.on('workspace:issues', ({ workspaceId, issues, publishRequests }) => {
            set({
              workspaces: get().workspaces.map((w) =>
                w.id === workspaceId ? { ...w, issues, publishRequests } : w,
              ),
            });
          }),
          api.on('orchestrator:report', ({ workspaceId, ...report }) => {
            const list = get().loopReports[workspaceId] ?? [];
            set({
              loopReports: {
                ...get().loopReports,
                [workspaceId]: [...list, { ...report, at: new Date().toISOString() }].slice(
                  -MAX_LOOP_REPORTS,
                ),
              },
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
        const opened = { workspaceId, step: 'counts' } as const;
        set({ launcher: opened });
        // Only a warning: the launcher never waits for it, and a failed check says nothing.
        void Promise.resolve(api.invoke('workspace:hasLocalChanges', { id: workspaceId })).then(
          (localChanges) => {
            if (localChanges && get().launcher === opened) {
              set({ launcher: { ...opened, localChanges } });
            }
          },
          () => undefined,
        );
      },

      closeLauncher() {
        set({ launcher: null });
      },

      async requestLaunch(draft) {
        const { launcher, workspaces, permission } = get();
        if (!launcher) return;
        const { workspaceId } = launcher;
        const workspace = workspaces.find((w) => w.id === workspaceId);
        const level = workspace?.permissionOverride?.level ?? permission?.level;
        if (level) await launch(workspaceId, draft, level);
        // Free terminals alone run no agent: no permission to ask for.
        else if (draft.agents.length === 0) await launch(workspaceId, draft, 'always-ask');
        else set({ launcher: { workspaceId, step: 'permission', draft } });
      },

      async confirmPermission(choice) {
        const { launcher } = get();
        if (launcher?.step !== 'permission') return;
        const { workspaceId, draft } = launcher;
        const project = choice.scope === 'project';
        try {
          await api.invoke('permission:set', { ...choice, ...(project ? { workspaceId } : {}) });
        } catch (error) {
          set({
            launcher: { workspaceId, step: 'counts', draft, error: asIpcError(error).message },
          });
          return;
        }
        if (!project) set({ permission: choice });
        await launch(workspaceId, draft, choice.level);
      },

      async redetectClis() {
        set({ clis: await api.invoke('cli:redetect') });
      },

      async addCli(name, command) {
        try {
          const added = await api.invoke('cli:add', { name, command });
          set({ clis: [...get().clis.filter((cli) => cli.id !== added.id), added] });
          return null;
        } catch (error) {
          return asIpcError(error).message;
        }
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
      cancelAutoResume: (agentId) => act(() => api.invoke('agent:cancelAutoResume', { agentId })),

      confirmIntegrationRequest: (requestId, message) =>
        act(() => api.invoke('integrationRequest:confirm', { requestId, message })),

      refuseIntegrationRequest: (requestId) =>
        act(() => api.invoke('integrationRequest:refuse', { requestId })),

      decideLoop: (workspaceId, issueId, decision) =>
        act(() => api.invoke('loop:decide', { workspaceId, issueId, decision })),

      confirmPublish: (requestId) => act(() => api.invoke('publishRequest:confirm', { requestId })),

      refusePublish: (requestId) => act(() => api.invoke('publishRequest:refuse', { requestId })),

      loadOrchestratorActions: (agentId) =>
        act(async () => {
          const actions = await api.invoke('orchestrator:actions', { agentId });
          set({ orchestratorActions: { ...get().orchestratorActions, [agentId]: actions } });
        }),

      setUsageThresholds: (thresholds) =>
        act(async () => {
          set({ usageThresholds: await api.invoke('settings:usageThresholds', thresholds) });
        }),

      setRoleProfiles: (workspaceId, profiles) =>
        act(async () => {
          set({
            workspaces: get().workspaces.map((w) =>
              w.id === workspaceId ? { ...w, roleProfiles: profiles } : w,
            ),
          });
          await api.invoke('roles:setProfiles', { workspaceId, profiles });
        }),

      revokeOrchestrator: (agentId) =>
        act(async () => {
          await api.invoke('orchestrator:revoke', { agentId });
          set({
            workspaces: get().workspaces.map((w) => ({
              ...w,
              agents: w.agents.map((a) => (a.id === agentId ? { ...a, role: null } : a)),
            })),
          });
        }),

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

      markSeen: (agentId, path, blob) =>
        act(async () => {
          await api.invoke('review:setSeen', { agentId, path, seen: blob !== null });
          set({
            workspaces: updateAgent(get().workspaces, agentId, (agent) => {
              const seen = Object.fromEntries(
                Object.entries(agent.review.seen).filter(([seenPath]) => seenPath !== path),
              );
              if (blob !== null) seen[path] = blob;
              return { ...agent, review: { ...agent.review, seen } };
            }),
          });
        }),

      commentLine: (agentId, path, line, text) =>
        act(async () => {
          const comment = await api.invoke('review:comment', { agentId, path, line, text });
          set({
            workspaces: updateAgent(get().workspaces, agentId, (agent) => ({
              ...agent,
              review: { ...agent.review, comments: [...agent.review.comments, comment] },
            })),
            correcting: { ...get().correcting, [agentId]: 'queued' },
          });
        }),

      sendToAgent: (agentId, kind, text) =>
        act(async () => {
          await api.invoke(
            'review:send',
            kind === 'request' ? { agentId, kind, text: text ?? '' } : { agentId, kind },
          );
          set({
            ...(kind === 'fix-comments'
              ? {
                  workspaces: updateAgent(get().workspaces, agentId, (agent) => ({
                    ...agent,
                    review: {
                      ...agent.review,
                      comments: agent.review.comments.map((c) => ({ ...c, treated: true })),
                    },
                  })),
                }
              : {}),
            correcting: { ...get().correcting, [agentId]: 'queued' },
          });
        }),
    };
  });
}

export type AppStore = ReturnType<typeof createAppStore>;

/** 005 — the usage states keyed by account. */
const byAccount = (states: readonly UsageState[]): Record<string, UsageState> =>
  Object.fromEntries(states.map((state) => [`${state.cliId}\u0000${state.account}`, state]));
