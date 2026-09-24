import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchWatcher } from '../../../../src/main/agents/branch-watcher';

let branch: string | Error;
let changes: [string, string][];
let watcher: BranchWatcher;

beforeEach(() => {
  vi.useFakeTimers();
  branch = 'agent/fake-1';
  changes = [];
  watcher = new BranchWatcher({
    currentBranch: () =>
      branch instanceof Error ? Promise.reject(branch) : Promise.resolve(branch),
    onBranch: (id, name) => changes.push([id, name]),
    intervalMs: 5000,
  });
  watcher.watch('a1', '/repo/.worktrees/fake-1', 'agent/fake-1');
});

afterEach(() => {
  watcher.dispose();
  vi.useRealTimers();
});

describe('BranchWatcher', () => {
  it('announces a renamed branch once, on the next periodic check', async () => {
    branch = 'feature/login';
    await vi.advanceTimersByTimeAsync(4999);
    expect(changes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([['a1', 'feature/login']]);
  });

  it('checks on demand, at the end of a turn', async () => {
    branch = 'feature/login';
    await watcher.check('a1');
    expect(changes).toEqual([['a1', 'feature/login']]);
  });

  it('keeps the last branch on a detached HEAD or a failing git', async () => {
    branch = '';
    await watcher.check('a1');
    branch = new Error('fatal: not a git repository');
    await watcher.check('a1');
    expect(changes).toEqual([]);
  });

  it('stops checking an agent it no longer watches', async () => {
    watcher.unwatch('a1');
    watcher.unwatch('a1');
    branch = 'feature/login';
    await watcher.check('a1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(changes).toEqual([]);
  });

  it('drops a check that ends after the agent stopped being watched', async () => {
    let resolve: (name: string) => void = () => undefined;
    const slow = new BranchWatcher({
      currentBranch: () => new Promise((r) => (resolve = r)),
      onBranch: (id, name) => changes.push([id, name]),
    });
    slow.watch('a2', '/repo/.worktrees/fake-2', 'agent/fake-2');
    const check = slow.check('a2');
    slow.dispose();
    resolve('feature/late');
    await check;
    expect(changes).toEqual([]);
  });
});
