import { createStore } from 'zustand/vanilla';
import { ipcErrorSchema, type IpcInput, type PactApi } from '../../shared/ipc';
import type {
  ConflictChoice,
  FileDiff,
  Integration,
  ReviewSnapshot,
  TestRun,
} from '../../shared/review';

// 002 T022 — the review shown in the Changements tab, fed by review:open and review:changed.
// T035 — the Décision column: the tests and the integration of each agent.
// T050 — screen 1q: the integrations stopped on a conflict, and what resolves them.

export type IntegrateRequest = Omit<IpcInput<'integration:start'>, 'agentId'>;

/** Where an agent's integration stands in the Décision column. */
export type Decision = { busy: boolean; error: { message: string; files: string[] } | null };

/** Where an integration is said to have landed, for « ✓ Intégré · branche → main ». */
export type IntegrationLabel = { workspaceId: string; branch: string; mainBranch: string };

export type ConflictAnswer = { hunk: number; choice: ConflictChoice } | { content: string };

export type ReviewState = {
  /** The agent whose review is open, followed by the main process until `close`. */
  agentId: string | null;
  snapshot: ReviewSnapshot | null;
  selected: string | null;
  diff: FileDiff | null;
  error: string | null;
  /** The agents with changes to review, per workspace (`review:pending`). */
  pending: Record<string, string[]>;
  /** The last test run of each agent (`review:tests`). */
  tests: Record<string, TestRun>;
  decisions: Record<string, Decision>;
  /** The integrations stopped on a conflict, per agent (screen 1q, FR-027). */
  integrations: Record<string, Integration>;
  /** « ✓ Intégré · branche → main », shown briefly in its workspace (US2/AC6). */
  notice: { workspaceId: string; text: string } | null;
  /** Subscribes to main-process events; returns the function that unsubscribes. */
  connect: () => () => void;
  loadPending: (workspaceId: string) => Promise<void>;
  open: (agentId: string) => Promise<void>;
  close: () => void;
  select: (path: string) => Promise<void>;
  runTests: (agentId: string) => Promise<void>;
  cancelTests: (agentId: string) => Promise<void>;
  /** Saves the command for the workspace, then runs the tests of the agent with it. */
  setTestCommand: (workspaceId: string, agentId: string, command: string) => Promise<void>;
  integrate: (agentId: string, request: IntegrateRequest, label: IntegrationLabel) => Promise<void>;
  dismissNotice: () => void;
  resolveConflict: (agentId: string, path: string, answer: ConflictAnswer) => Promise<void>;
  openInEditor: (agentId: string, path: string) => Promise<void>;
  askAgent: (agentId: string) => Promise<void>;
  finishIntegration: (agentId: string, label: IntegrationLabel) => Promise<void>;
  cancelIntegration: (agentId: string) => Promise<void>;
};

/** The states of an integration that screen 1q shows. */
const ON_SCREEN: Integration['state'][] = ['conflicted', 'waiting-agent', 'checking', 'committing'];

const message = (error: unknown) => {
  const parsed = ipcErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.message : 'Erreur inattendue';
};

const failure = (error: unknown) => {
  const parsed = ipcErrorSchema.safeParse(error);
  return parsed.success
    ? { message: parsed.data.message, files: parsed.data.files ?? [] }
    : { message: 'Erreur inattendue', files: [] };
};

const CLOSED = { agentId: null, snapshot: null, selected: null, diff: null, error: null };

export function createReviewStore(api: PactApi) {
  return createStore<ReviewState>()((set, get) => {
    /** Loads the diff of `path`, unless another file or agent is shown by the time it arrives. */
    const loadDiff = async (agentId: string, path: string) => {
      try {
        const diff = await api.invoke('review:fileDiff', { agentId, path });
        if (get().agentId === agentId && get().selected === path) set({ diff });
      } catch (error) {
        if (get().agentId === agentId && get().selected === path) set({ error: message(error) });
      }
    };

    /** Shows `snapshot`, keeping the file selected while it is still there. */
    const show = (snapshot: ReviewSnapshot) => {
      const { selected, snapshot: previous } = get();
      const kept = snapshot.files.find((file) => file.path === selected);
      const next = kept ?? snapshot.files[0];
      const before = previous?.files.find((file) => file.path === next?.path);
      // The diff is read again when the file selected changes, or its content does.
      const stale = !kept || before?.blob !== next?.blob || previous?.base !== snapshot.base;
      set({
        snapshot,
        error: null,
        selected: next?.path ?? null,
        ...(stale ? { diff: null } : {}),
      });
      if (next && stale) void loadDiff(snapshot.agentId, next.path);
    };

    const decide = (agentId: string, decision: Decision) => {
      set({ decisions: { ...get().decisions, [agentId]: decision } });
    };
    const keepRun = (run: TestRun) => {
      set({ tests: { ...get().tests, [run.agentId]: run } });
    };
    /** Where each integration shown would land, for its notice. */
    const labels = new Map<string, IntegrationLabel>();
    const noticeFor = ({ workspaceId, branch, mainBranch }: IntegrationLabel) => ({
      workspaceId,
      text: `✓ Intégré · ${branch} → ${mainBranch}`,
    });
    /** Keeps an integration on screen 1q, or forgets it once over. */
    const keepIntegration = (integration: Integration) => {
      const { [integration.agentId]: shown, ...others } = get().integrations;
      if (ON_SCREEN.includes(integration.state)) {
        // A clean integration passes through these states too: only a conflict opens 1q.
        if (!shown && integration.state !== 'conflicted') return;
        set({ integrations: { ...others, [integration.agentId]: integration } });
        return;
      }
      if (!shown) return;
      set({ integrations: others });
      const label = labels.get(integration.agentId);
      if (integration.state === 'integrated' && label) set({ notice: noticeFor(label) });
      if (integration.state === 'failed' || integration.state === 'blocked') {
        decide(integration.agentId, {
          busy: false,
          error: { message: integration.error ?? 'Intégration échouée', files: [] },
        });
      }
    };
    /** Runs a request about the integration shown for `agentId`; its error goes to the column. */
    const onIntegration = async (
      agentId: string,
      action: (integration: Integration) => Promise<unknown>,
    ) => {
      const integration = get().integrations[agentId];
      if (!integration) return;
      try {
        await action(integration);
        decide(agentId, { busy: false, error: null });
      } catch (error) {
        decide(agentId, { busy: false, error: failure(error) });
      }
    };

    return {
      ...CLOSED,
      pending: {},
      tests: {},
      decisions: {},
      integrations: {},
      notice: null,

      connect() {
        const unsubscribers = [
          api.on('review:changed', (snapshot) => {
            if (snapshot.agentId === get().agentId) show(snapshot);
          }),
          api.on('review:pending', ({ workspaceId, agentIds }) => {
            set({ pending: { ...get().pending, [workspaceId]: agentIds } });
          }),
          api.on('review:tests', keepRun),
          api.on('integration:state', keepIntegration),
        ];
        return () => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        };
      },

      async loadPending(workspaceId) {
        try {
          const agentIds = await api.invoke('review:listPending', { workspaceId });
          set({ pending: { ...get().pending, [workspaceId]: agentIds } });
        } catch {
          // The next review:pending event brings it.
        }
      },

      async open(agentId) {
        set({ ...CLOSED, agentId });
        try {
          const snapshot = await api.invoke('review:open', { agentId });
          if (get().agentId === agentId) show(snapshot);
        } catch (error) {
          if (get().agentId === agentId) set({ error: message(error) });
        }
      },

      close() {
        const { agentId } = get();
        if (agentId === null) return;
        set(CLOSED);
        void api.invoke('review:close', { agentId }).catch(() => undefined);
      },

      async select(path) {
        const { agentId } = get();
        if (agentId === null) return;
        set({ selected: path, diff: null });
        await loadDiff(agentId, path);
      },

      async runTests(agentId) {
        try {
          keepRun(await api.invoke('review:runTests', { agentId }));
        } catch (error) {
          decide(agentId, { busy: false, error: failure(error) });
        }
      },

      async cancelTests(agentId) {
        // The cancelled run comes back with review:tests.
        await api.invoke('review:cancelTests', { agentId }).catch(() => undefined);
      },

      async setTestCommand(workspaceId, agentId, command) {
        try {
          await api.invoke('workspace:setTestCommand', { workspaceId, command });
        } catch (error) {
          decide(agentId, { busy: false, error: failure(error) });
          return;
        }
        // Until the next snapshot says it, the review shown knows its command now.
        const { snapshot } = get();
        if (snapshot?.agentId === agentId) set({ snapshot: { ...snapshot, testCommand: command } });
        await get().runTests(agentId);
      },

      async integrate(agentId, request, label) {
        decide(agentId, { busy: true, error: null });
        labels.set(agentId, label);
        try {
          const integration = await api.invoke('integration:start', { agentId, ...request });
          decide(agentId, { busy: false, error: null });
          if (integration.state === 'integrated') set({ notice: noticeFor(label) });
          // In conflict, main has not moved: screen 1q opens on it (FR-027).
          else keepIntegration(integration);
        } catch (error) {
          decide(agentId, { busy: false, error: failure(error) });
        }
      },

      resolveConflict: (agentId, path, answer) =>
        onIntegration(agentId, async ({ id }) => {
          const file = await api.invoke('integration:resolve', {
            integrationId: id,
            path,
            ...answer,
          });
          const shown = get().integrations[agentId];
          if (!shown) return;
          const conflicts = shown.conflicts.map((f) => (f.path === path ? file : f));
          set({ integrations: { ...get().integrations, [agentId]: { ...shown, conflicts } } });
        }),

      openInEditor: (agentId, path) =>
        onIntegration(agentId, ({ id }) =>
          api.invoke('integration:openInEditor', { integrationId: id, path }),
        ),

      askAgent: (agentId) =>
        onIntegration(agentId, async ({ id }) => {
          keepIntegration(await api.invoke('integration:askAgent', { integrationId: id }));
        }),

      finishIntegration: (agentId, label) =>
        onIntegration(agentId, async ({ id }) => {
          labels.set(agentId, label);
          decide(agentId, { busy: true, error: null });
          keepIntegration(await api.invoke('integration:finish', { integrationId: id }));
        }),

      cancelIntegration: (agentId) =>
        onIntegration(agentId, async (integration) => {
          await api.invoke('integration:cancel', { integrationId: integration.id });
          keepIntegration({ ...integration, state: 'cancelled' });
        }),

      dismissNotice() {
        set({ notice: null });
      },
    };
  });
}

export type ReviewStore = ReturnType<typeof createReviewStore>;

/** A review store that never opens anything, for an app built without one (tests). */
export const idleReviewStore: ReviewStore = createStore<ReviewState>()(() => ({
  ...CLOSED,
  pending: {},
  tests: {},
  decisions: {},
  integrations: {},
  notice: null,
  connect: () => () => undefined,
  loadPending: () => Promise.resolve(),
  open: () => Promise.resolve(),
  close: () => undefined,
  select: () => Promise.resolve(),
  runTests: () => Promise.resolve(),
  cancelTests: () => Promise.resolve(),
  setTestCommand: () => Promise.resolve(),
  integrate: () => Promise.resolve(),
  dismissNotice: () => undefined,
  resolveConflict: () => Promise.resolve(),
  openInEditor: () => Promise.resolve(),
  askAgent: () => Promise.resolve(),
  finishIntegration: () => Promise.resolve(),
  cancelIntegration: () => Promise.resolve(),
}));
