import { describe, expect, it, vi } from 'vitest';
import { createReviewStore } from '../../../../src/renderer/store/review-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import type { FileDiff, ReviewSnapshot } from '../../../../src/shared/review';
import { diff, file, snapshot } from '../review/fixtures';
import { uuid } from '../tiles/fixtures';

// 002 T022 — the review shown in the Changements tab: snapshot, file selected, its diff.

type Invoke = (channel: string, input?: unknown) => Promise<unknown>;

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const setup = (answers: Partial<Record<string, (input: never) => unknown>> = {}) => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn<Invoke>((channel, input) => {
    const answer = answers[channel];
    if (answer) return Promise.resolve(answer(input as never));
    if (channel === 'review:open') return Promise.resolve(snapshot());
    if (channel === 'review:fileDiff') {
      return Promise.resolve(diff((input as { path: string }).path));
    }
    if (channel === 'review:listPending') return Promise.resolve([uuid(1)]);
    return Promise.resolve(undefined);
  });
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  } as unknown as PactApi;
  const store = createReviewStore(api);
  const disconnect = store.getState().connect();
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    listeners.get(channel)?.(payload);
  };
  return { store, invoke, emit, disconnect, listeners };
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('review store', () => {
  it('opens the review of an agent on its first file, with its diff', async () => {
    const { store, invoke } = setup();
    await store.getState().open(uuid(1));
    await settle();
    expect(invoke).toHaveBeenCalledWith('review:open', { agentId: uuid(1) });
    expect(store.getState()).toMatchObject({
      agentId: uuid(1),
      snapshot: snapshot(),
      selected: 'src/auth.ts',
      diff: diff('src/auth.ts'),
      error: null,
    });
  });

  it('selects another file and loads its diff', async () => {
    const { store, invoke } = setup();
    await store.getState().open(uuid(1));
    await store.getState().select('src/db.ts');
    expect(invoke).toHaveBeenLastCalledWith('review:fileDiff', {
      agentId: uuid(1),
      path: 'src/db.ts',
    });
    expect(store.getState()).toMatchObject({ selected: 'src/db.ts', diff: diff('src/db.ts') });
  });

  it('keeps the diff of the file selected last when an older one answers late', async () => {
    const slow = deferred<FileDiff>();
    const { store } = setup({
      'review:fileDiff': ({ path }: { path: string }) =>
        path === 'src/old.ts' ? slow.promise : diff(path),
    });
    await store.getState().open(uuid(1));
    const old = store.getState().select('src/old.ts');
    await store.getState().select('src/db.ts');
    slow.resolve(diff('src/old.ts'));
    await old;
    expect(store.getState()).toMatchObject({ selected: 'src/db.ts', diff: diff('src/db.ts') });
  });

  it('drops the snapshot of an agent left before it arrived', async () => {
    const slow = deferred<ReviewSnapshot>();
    const { store } = setup({
      'review:open': ({ agentId }: { agentId: string }) =>
        agentId === uuid(1) ? slow.promise : snapshot({ agentId: uuid(2), files: [] }),
    });
    const first = store.getState().open(uuid(1));
    await store.getState().open(uuid(2));
    slow.resolve(snapshot());
    await first;
    expect(store.getState()).toMatchObject({ agentId: uuid(2), selected: null });
    expect(store.getState().snapshot?.agentId).toBe(uuid(2));
  });

  it('follows review:changed for the agent shown only, reloading a changed file', async () => {
    const { store, invoke, emit } = setup();
    await store.getState().open(uuid(1));
    await settle();
    invoke.mockClear();
    emit('review:changed', snapshot({ agentId: uuid(2), files: [] }));
    expect(store.getState().snapshot?.files).toHaveLength(3);

    const files = snapshot().files.map((f) =>
      f.path === 'src/auth.ts' ? file('src/auth.ts', { blob: 'e'.repeat(40) }) : f,
    );
    emit('review:changed', snapshot({ files }));
    await settle();
    expect(store.getState().snapshot?.files[0]?.blob).toBe('e'.repeat(40));
    expect(invoke).toHaveBeenCalledWith('review:fileDiff', {
      agentId: uuid(1),
      path: 'src/auth.ts',
    });
  });

  it('moves to the first file when the one selected is gone', async () => {
    const { store, emit } = setup();
    await store.getState().open(uuid(1));
    await settle();
    emit('review:changed', snapshot({ files: snapshot().files.slice(1) }));
    await settle();
    expect(store.getState()).toMatchObject({ selected: 'src/db.ts', diff: diff('src/db.ts') });
  });

  it('closes the review it follows', async () => {
    const { store, invoke } = setup();
    await store.getState().open(uuid(1));
    store.getState().close();
    expect(invoke).toHaveBeenLastCalledWith('review:close', { agentId: uuid(1) });
    expect(store.getState()).toMatchObject({ agentId: null, snapshot: null, selected: null });
  });

  it('shows why the review could not be opened', async () => {
    const { store } = setup({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      'review:open': () => Promise.reject({ code: 'GIT_FAILED', message: 'git a échoué' }),
    });
    await store.getState().open(uuid(1));
    expect(store.getState()).toMatchObject({ snapshot: null, error: 'git a échoué' });
  });

  it('keeps the agents to review per workspace, asked once and then announced', async () => {
    const { store, invoke, emit } = setup();
    await store.getState().loadPending('w1');
    expect(invoke).toHaveBeenCalledWith('review:listPending', { workspaceId: 'w1' });
    expect(store.getState().pending).toEqual({ w1: [uuid(1)] });
    emit('review:pending', { workspaceId: 'w2', agentIds: [uuid(2)] });
    expect(store.getState().pending).toEqual({ w1: [uuid(1)], w2: [uuid(2)] });
  });

  it('unsubscribes', () => {
    const { disconnect, listeners } = setup();
    disconnect();
    expect(listeners.size).toBe(0);
  });
});
