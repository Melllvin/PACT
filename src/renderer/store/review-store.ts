import { createStore } from 'zustand/vanilla';
import { ipcErrorSchema, type IpcInput, type PactApi } from '../../shared/ipc';
import type { FileDiff, ReviewSnapshot, TestRun } from '../../shared/review';

// 002 T022 — the review shown in the Changements tab, fed by review:open and review:changed.
// T035 — the Décision column: the tests and the integration of each agent.

export type IntegrateRequest = Omit<IpcInput<'integration:start'>, 'agentId'>;

/** Where an agent's integration stands in the Décision column. */
export type Decision = { busy: boolean; error: { message: string; files: string[] } | null };

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
  integrate: (
    agentId: string,
    request: IntegrateRequest,
    label: { workspaceId: string; branch: string; mainBranch: string },
  ) => Promise<void>;
  dismissNotice: () => void;
};

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

    return {
      ...CLOSED,
      pending: {},
      tests: {},
      decisions: {},
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

      async integrate(agentId, request, { workspaceId, branch, mainBranch }) {
        decide(agentId, { busy: true, error: null });
        try {
          const integration = await api.invoke('integration:start', { agentId, ...request });
          if (integration.state === 'integrated') {
            decide(agentId, { busy: false, error: null });
            set({ notice: { workspaceId, text: `✓ Intégré · ${branch} → ${mainBranch}` } });
            return;
          }
          // The conflict screen comes with US4 (FR-027); main has not moved.
          decide(agentId, {
            busy: false,
            error: {
              message: `Conflit avec ${mainBranch} : rien n’a été intégré.`,
              files: integration.conflicts.map((conflict) => conflict.path),
            },
          });
        } catch (error) {
          decide(agentId, { busy: false, error: failure(error) });
        }
      },

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
}));
