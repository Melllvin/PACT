import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORIGIN_SYNC_MS, OriginSync } from '../../../src/main/origin-sync';

// fix-todo-diff-notifications — `git fetch origin <main>` every minute and at opening, never a PR.

const target = (over: Partial<{ available: boolean; mainBranch: string }> = {}) => ({
  id: 'w1',
  path: '/repo',
  mainBranch: 'main',
  available: true,
  ...over,
});

const setup = (targets = [target()], fetchOrigin = vi.fn(() => Promise.resolve(true))) => {
  const refresh = vi.fn(() => Promise.resolve([]));
  const sync = new OriginSync({ workspaces: () => targets, fetchOrigin, refresh });
  return { sync, fetchOrigin, refresh };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('OriginSync', () => {
  it('fetches the main branch of the workspace only, then recalculates what is to review', async () => {
    const { sync, fetchOrigin, refresh } = setup();
    await sync.sync('w1');
    expect(fetchOrigin).toHaveBeenCalledExactlyOnceWith('/repo', 'main');
    expect(refresh).toHaveBeenCalledWith('w1');
  });

  it('recalculates anyway when the fetch fails: the last origin known is the base', async () => {
    const { sync, refresh } = setup(
      [target()],
      vi.fn(() => Promise.resolve(false)),
    );
    await sync.sync('w1');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does nothing for an unknown, unavailable or main-less workspace', async () => {
    for (const targets of [[], [target({ available: false })], [target({ mainBranch: '' })]]) {
      const { sync, fetchOrigin } = setup(targets);
      await sync.sync('w1');
      expect(fetchOrigin).not.toHaveBeenCalled();
    }
  });

  it('survives a refresh that fails', async () => {
    const refresh = vi.fn(() => Promise.reject(new Error('git')));
    const sync = new OriginSync({
      workspaces: () => [target()],
      fetchOrigin: () => Promise.resolve(true),
      refresh,
    });
    await expect(sync.sync('w1')).resolves.toBeUndefined();
  });

  it('starts again every minute, and stops', async () => {
    vi.useFakeTimers();
    const { sync, fetchOrigin } = setup();
    sync.start();
    await vi.advanceTimersByTimeAsync(ORIGIN_SYNC_MS * 2);
    expect(fetchOrigin).toHaveBeenCalledTimes(2);
    sync.stop();
    await vi.advanceTimersByTimeAsync(ORIGIN_SYNC_MS * 2);
    expect(fetchOrigin).toHaveBeenCalledTimes(2);
  });

  it('never stacks two syncs of a workspace while a slow remote holds the first', async () => {
    let release: () => void = () => undefined;
    const fetchOrigin = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(true);
          };
        }),
    );
    const { sync, refresh } = setup([target()], fetchOrigin);
    const first = sync.sync('w1');
    await sync.sync('w1');
    expect(fetchOrigin).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(refresh).toHaveBeenCalledTimes(1);
    // Once it is over, the next one goes.
    const second = sync.sync('w1');
    release();
    await second;
    expect(fetchOrigin).toHaveBeenCalledTimes(2);
  });
});
