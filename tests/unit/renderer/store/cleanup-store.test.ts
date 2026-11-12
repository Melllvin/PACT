import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';

// 008 US8 / R1 — what the renderer sends for « Supprimer quand même » and « Garder ».

const DELIVERY = '00000000-0000-4000-8000-000000000090';
const AGENT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

function setup(answers: Record<string, unknown>[] | Error) {
  const queue = Array.isArray(answers) ? [...answers] : answers;
  const invoke = vi.fn((channel: string, _input?: unknown) => {
    if (channel === 'delivery:cleanup') {
      if (queue instanceof Error) return Promise.reject(queue);
      return Promise.resolve(queue.shift() ?? { lost: [] });
    }
    return Promise.resolve({ recents: [], clis: [], permission: null, workspaces: [] });
  });
  const api = { invoke, on: () => () => undefined } as unknown as PactApi;
  const store = createAppStore(api);
  const sent = () =>
    invoke.mock.calls
      .filter(([channel]) => channel === 'delivery:cleanup')
      .map(([, input]) => input);
  return { store, sent };
}

describe('cleanupWorktree', () => {
  it('Given the first step, When the list is asked, Then no confirmation and no list are sent, and the answer comes back', async () => {
    const { store, sent } = setup([{ lost: ['a (non suivi)'] }]);

    const answer = await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force');

    expect(answer).toEqual({ lost: ['a (non suivi)'] });
    expect(sent()).toEqual([{ deliveryId: DELIVERY, agentId: AGENT, decision: 'force' }]);
  });

  it('Given a list that was shown, When the user confirms, Then the confirmation carries that very list (R1)', async () => {
    const { store, sent } = setup([{ lost: ['a (non suivi)', 'b (modifié)'] }, { lost: [] }]);
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force');

    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    expect(sent()[1]).toEqual({
      deliveryId: DELIVERY,
      agentId: AGENT,
      decision: 'force',
      confirmed: true,
      seen: ['a (non suivi)', 'b (modifié)'],
    });
  });

  it('Given the list changed, When the answer shows a new one, Then the next confirmation is bound to the new one', async () => {
    const { store, sent } = setup([
      { lost: ['a'] },
      { lost: ['a', 'added-later'] },
      { lost: ['a', 'added-later'] },
    ]);
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force');
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    expect(sent()[1]).toMatchObject({ seen: ['a'] });
    expect(sent()[2]).toMatchObject({ seen: ['a', 'added-later'] });
  });

  it('Given a confirmation with no list ever shown, When it is sent, Then it carries an empty list, which never matches a real loss', async () => {
    const { store, sent } = setup([{ lost: ['a'] }]);

    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    expect(sent()[0]).toMatchObject({ confirmed: true, seen: [] });
  });

  it('Given two worktrees, When one list was shown, Then the other one is not bound to it', async () => {
    const { store, sent } = setup([{ lost: ['a'] }, { lost: [] }]);
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force');

    await store.getState().cleanupWorktree(DELIVERY, OTHER, 'force', true);

    expect(sent()[1]).toMatchObject({ agentId: OTHER, seen: [] });
  });

  it('Given « Garder », When it is sent, Then no list goes with it and the list shown is forgotten', async () => {
    const { store, sent } = setup([{ lost: ['a'] }, { lost: [] }, { lost: [] }]);
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force');

    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'keep');
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    expect(sent()[1]).toEqual({ deliveryId: DELIVERY, agentId: AGENT, decision: 'keep' });
    expect(sent()[2]).toMatchObject({ seen: [] });
  });

  it('Given a failing call, When it is sent, Then the error is shown as the action error and null comes back', async () => {
    const { store } = setup(new Error('cannot remove a locked working tree'));

    const answer = await store.getState().cleanupWorktree(DELIVERY, AGENT, 'force', true);

    expect(answer).toBeNull();
    expect(store.getState().actionError).toContain('cannot remove a locked working tree');
  });

  it('Given a call that works after a failure, When it answers, Then the action error is cleared', async () => {
    const { store } = setup([{ lost: [] }]);
    await store.getState().cleanupWorktree(DELIVERY, AGENT, 'keep');
    expect(store.getState().actionError).toBeNull();
  });
});
