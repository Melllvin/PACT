import { createStore } from 'zustand/vanilla';
import { ipcErrorSchema, type PactApi } from '../../shared/ipc';
import type { FileDiff, ReviewSnapshot } from '../../shared/review';

// 002 T022 — the review shown in the Changements tab, fed by review:open and review:changed.

export type ReviewState = {
  /** The agent whose review is open, followed by the main process until `close`. */
  agentId: string | null;
  snapshot: ReviewSnapshot | null;
  selected: string | null;
  diff: FileDiff | null;
  error: string | null;
  /** The agents with changes to review, per workspace (`review:pending`). */
  pending: Record<string, string[]>;
  /** Subscribes to main-process events; returns the function that unsubscribes. */
  connect: () => () => void;
  loadPending: (workspaceId: string) => Promise<void>;
  open: (agentId: string) => Promise<void>;
  close: () => void;
  select: (path: string) => Promise<void>;
};

const message = (error: unknown) => {
  const parsed = ipcErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.message : 'Erreur inattendue';
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

    return {
      ...CLOSED,
      pending: {},

      connect() {
        const unsubscribers = [
          api.on('review:changed', (snapshot) => {
            if (snapshot.agentId === get().agentId) show(snapshot);
          }),
          api.on('review:pending', ({ workspaceId, agentIds }) => {
            set({ pending: { ...get().pending, [workspaceId]: agentIds } });
          }),
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
    };
  });
}

export type ReviewStore = ReturnType<typeof createReviewStore>;

/** A review store that never opens anything, for an app built without one (tests). */
export const idleReviewStore: ReviewStore = createStore<ReviewState>()(() => ({
  ...CLOSED,
  pending: {},
  connect: () => () => undefined,
  loadPending: () => Promise.resolve(),
  open: () => Promise.resolve(),
  close: () => undefined,
  select: () => Promise.resolve(),
}));
