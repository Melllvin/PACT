import { describe, expect, it, vi } from 'vitest';
import { createReviewStore, idleReviewStore } from '../../../../src/renderer/store/review-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import type { FileDiff, Integration, ReviewSnapshot, TestRun } from '../../../../src/shared/review';
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

// 002 T035 — the Décision column: tests, integration and the « ✓ Intégré » notice.

const testRun = (overrides: Partial<TestRun> = {}): TestRun => ({
  agentId: uuid(1),
  command: 'npm test',
  tree: snapshot().tree,
  status: 'running',
  passedCount: null,
  outputTail: '',
  ...overrides,
});

const integration = (overrides: Partial<Integration> = {}): Integration => ({
  id: uuid(50),
  agentId: uuid(1),
  mode: 'squash',
  message: 'Ajoute les sessions',
  after: { closeTile: true, removeWorktree: true },
  snapshot: snapshot().tree,
  mainAtStart: snapshot().base,
  state: 'integrated',
  conflicts: [],
  error: null,
  ...overrides,
});

const request = {
  mode: 'squash' as const,
  message: 'Ajoute les sessions',
  after: { closeTile: true, removeWorktree: true },
};
const label = { workspaceId: 'w1', branch: 'agent/pg-sessions', mainBranch: 'main' };

describe('review store, Décision column', () => {
  it('keeps the last test run of each agent, from requests and review:tests', async () => {
    const { store, invoke, emit } = setup({ 'review:runTests': () => testRun() });
    await store.getState().runTests(uuid(1));
    expect(invoke).toHaveBeenCalledWith('review:runTests', { agentId: uuid(1) });
    expect(store.getState().tests[uuid(1)]).toEqual(testRun());
    emit('review:tests', testRun({ agentId: uuid(2), status: 'passed', passedCount: 3 }));
    expect(store.getState().tests[uuid(2)]).toMatchObject({ status: 'passed', passedCount: 3 });
  });

  it('shows why the tests could not run', async () => {
    const { store } = setup({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      'review:runTests': () => Promise.reject({ code: 'INVALID_INPUT', message: 'Non configurés' }),
    });
    await store.getState().runTests(uuid(1));
    expect(store.getState().decisions[uuid(1)]).toEqual({
      busy: false,
      error: { message: 'Non configurés', files: [] },
    });
  });

  it('cancels the tests, whatever the answer', async () => {
    const { store, invoke } = setup({
      'review:cancelTests': () => Promise.reject(new Error('gone')),
    });
    await store.getState().cancelTests(uuid(1));
    expect(invoke).toHaveBeenCalledWith('review:cancelTests', { agentId: uuid(1) });
  });

  it('saves the test command of the workspace, shows it in the review and runs the tests', async () => {
    const { store, invoke } = setup({
      'review:runTests': () => testRun({ command: 'make check' }),
    });
    await store.getState().open(uuid(1));
    await store.getState().setTestCommand('w1', uuid(1), 'make check');
    expect(invoke).toHaveBeenCalledWith('workspace:setTestCommand', {
      workspaceId: 'w1',
      command: 'make check',
    });
    expect(store.getState().snapshot?.testCommand).toBe('make check');
    expect(store.getState().tests[uuid(1)]).toMatchObject({ command: 'make check' });
  });

  it('saves the test command of an agent no longer shown without touching the review', async () => {
    const { store } = setup({ 'review:runTests': () => testRun({ agentId: uuid(2) }) });
    await store.getState().open(uuid(1));
    await store.getState().setTestCommand('w1', uuid(2), 'make check');
    expect(store.getState().snapshot?.testCommand).toBe('npm test');
  });

  it('shows why the test command could not be saved', async () => {
    const { store, invoke } = setup({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      'workspace:setTestCommand': () => Promise.reject({ code: 'NOT_FOUND', message: 'Inconnu' }),
    });
    await store.getState().setTestCommand('w1', uuid(1), 'make check');
    expect(store.getState().decisions[uuid(1)]?.error?.message).toBe('Inconnu');
    expect(invoke).not.toHaveBeenCalledWith('review:runTests', expect.anything());
  });

  it('integrates, busy meanwhile, then gives the notice of the workspace (US2/AC6)', async () => {
    let done: (value: Integration) => void = () => undefined;
    const { store, invoke } = setup({
      'integration:start': () =>
        new Promise<Integration>((resolve) => {
          done = resolve;
        }),
    });
    const running = store.getState().integrate(uuid(1), request, label);
    expect(store.getState().decisions[uuid(1)]).toEqual({ busy: true, error: null });
    expect(store.getState().decisions[uuid(2)]).toBeUndefined();
    done(integration());
    await running;
    expect(invoke).toHaveBeenCalledWith('integration:start', { agentId: uuid(1), ...request });
    expect(store.getState().decisions[uuid(1)]).toEqual({ busy: false, error: null });
    expect(store.getState().notice).toEqual({
      workspaceId: 'w1',
      text: '✓ Intégré · agent/pg-sessions → main',
    });
    store.getState().dismissNotice();
    expect(store.getState().notice).toBeNull();
  });

  it('lists the files of a refused integration (FR-021)', async () => {
    const { store } = setup({
      'integration:start': () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject({ code: 'LOCAL_CHANGES', message: 'Bloquée', files: ['src/db.ts'] }),
    });
    await store.getState().integrate(uuid(1), request, label);
    expect(store.getState().decisions[uuid(1)]).toEqual({
      busy: false,
      error: { message: 'Bloquée', files: ['src/db.ts'] },
    });
    expect(store.getState().notice).toBeNull();
  });

  it('says which files conflict, main left as it was (FR-027)', async () => {
    const conflicts = ['src/db.ts', 'src/auth.ts'].map((path) => ({
      path,
      kind: 'content' as const,
      mainCommit: { short: 'abc1234', subject: 'Corrige' },
      hunks: [],
      edited: null,
      resolved: false,
    }));
    const { store } = setup({
      'integration:start': () => integration({ state: 'conflicted', conflicts }),
    });
    await store.getState().integrate(uuid(1), request, label);
    expect(store.getState().decisions[uuid(1)]).toEqual({
      busy: false,
      error: {
        message: 'Conflit avec main : rien n’a été intégré.',
        files: ['src/db.ts', 'src/auth.ts'],
      },
    });
  });
});

describe('idle review store', () => {
  it('opens nothing and runs nothing, for an app built without a review', async () => {
    const state = idleReviewStore.getState();
    state.connect()();
    await state.loadPending('w1');
    await state.open(uuid(1));
    state.close();
    await state.select('a.ts');
    await state.runTests(uuid(1));
    await state.cancelTests(uuid(1));
    await state.setTestCommand('w1', uuid(1), 'make');
    await state.integrate(uuid(1), request, label);
    state.dismissNotice();
    expect(idleReviewStore.getState()).toMatchObject({ agentId: null, tests: {}, notice: null });
  });
});
