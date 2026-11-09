import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CiWatcher } from '../../../../src/main/delivery/ci-watcher';
import { CI_POLL_MS, type Delivery } from '../../../../src/shared/delivery';
import type { Workspace } from '../../../../src/shared/model';

// 008 phase 4, round 2 — what the tester found on 3d8e8a44: the resume after a restart reads every
// followed state (D1), a foreign head drops a failed merge too (D2), and a rerun is counted by the
// name of the check on a head, not by the id of a job that GitHub renews at every rerun (D3).

const R = 'a'.repeat(40);
const FOREIGN = 'b'.repeat(40);
const ID = '00000000-0000-4000-8000-000000000001';
const START = '2026-11-09T10:00:00.000Z';

const delivery = (extra: Partial<Delivery> = {}): Delivery => ({
  id: ID,
  agentId: '00000000-0000-4000-8000-000000000003',
  testAgentId: null,
  issueId: null,
  branch: 'feat/x',
  target: 'main',
  channel: 'github',
  unverified: false,
  title: 'T',
  message: 'm',
  frozenCommit: R,
  verdictCommit: R,
  pactCommits: [R],
  pushedHead: R,
  rebases: 0,
  state: 'watching',
  reason: null,
  pr: { number: 7, url: 'https://x/pull/7', expectedAuthor: 'me' },
  ci: null,
  review: { required: false, refusedOnce: false },
  cleanup: 'none',
  requestedBy: 'user',
  at: START,
  updatedAt: START,
  ...extra,
});

function setup(d: Delivery, prState = 'OPEN', head = R) {
  let statusList: { context: string; state: string }[] = [];
  let ws = { id: 'w1', deliveries: [d] } as unknown as Workspace;
  let checks: { id: number; name: string; status: string; conclusion: string | null }[] = [];
  const forge = {
    prView: vi.fn(() => Promise.resolve({ state: prState, headRefOid: head })),
    checkRuns: vi.fn(() => Promise.resolve(checks)),
    statuses: vi.fn(() => Promise.resolve(statusList)),
    requiredChecks: vi.fn(() => Promise.resolve(['ci'])),
    rerunJob: vi.fn(() => Promise.resolve()),
  };
  const on = {
    green: vi.fn(),
    red: vi.fn(),
    dropped: vi.fn(),
    alert: vi.fn(),
    closed: vi.fn(),
  };
  const watcher = new CiWatcher({
    workspaces: {
      get: () => ws,
      list: () => [ws],
      update: (_id: string, change: (w: Workspace) => Workspace) => {
        ws = change(ws);
        return Promise.resolve(ws);
      },
    },
    forge: () => forge as never,
    repo: () => Promise.resolve('pact/test'),
    workflows: () => Promise.resolve(true),
    on,
  });
  return {
    watcher,
    forge,
    on,
    setChecks: (next: typeof checks) => (checks = next),
    setStatuses: (next: typeof statusList) => (statusList = next),
    setState: (state: Delivery['state']) => {
      ws = { ...ws, deliveries: [{ ...(ws.deliveries[0] as Delivery), state }] };
    },
    ci: () => (ws.deliveries[0] as Delivery).ci,
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => {
  vi.useFakeTimers({ now: new Date(START) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('D1 — resume reads every followed state', () => {
  it.each(['reviewing', 'merge-failed'] as const)(
    'Given a %s request and a PR merged by someone else, When the app restarts, Then the PR is read at once and the close is told',
    async (state) => {
      const t = setup(delivery({ state }), 'MERGED');
      t.watcher.resume(['watching', 'reviewing', 'merge-failed']);
      await tick(0);
      expect(t.forge.prView).toHaveBeenCalledTimes(1);
      expect(t.on.closed).toHaveBeenCalledWith(expect.objectContaining({ state: 'MERGED' }));
      t.watcher.dispose();
    },
  );

  it('Given requests in a final state, When the app restarts, Then they are not read', async () => {
    const t = setup(delivery({ state: 'merged' }));
    t.watcher.resume();
    await tick(CI_POLL_MS);
    expect(t.forge.prView).not.toHaveBeenCalled();
    t.watcher.dispose();
  });
});

describe('D2 — a foreign head is never dropped silently', () => {
  it('Given a merge-failed request, When the head is not a commit of PACT, Then dropped is told', async () => {
    const t = setup(delivery({ state: 'merge-failed' }), 'OPEN', FOREIGN);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    expect(t.on.dropped).toHaveBeenCalledWith(expect.objectContaining({ head: FOREIGN }));
    t.watcher.dispose();
  });

  it('Given a merge-failed request, When it is read, Then the next read comes later than for a followed PR', async () => {
    const t = setup(delivery({ state: 'merge-failed' }));
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);
    await tick(CI_POLL_MS);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);
    await tick(CI_POLL_MS * 20);
    expect(t.forge.prView.mock.calls.length).toBeGreaterThan(1);
    t.watcher.dispose();
  });
});

describe('D3 — one rerun per check name and head', () => {
  const stalled = (id: number, name = 'ci') => ({
    id,
    name,
    status: 'completed',
    conclusion: 'cancelled',
  });

  it('Given a rerun that creates a new check run each time, When it is read again, Then the check is rerun once and the user is alerted', async () => {
    const t = setup(delivery());
    t.watcher.track('w1', ID);
    let id = 40;
    for (let i = 0; i < 6; i++) {
      t.setChecks([stalled(++id)]);
      await tick(CI_POLL_MS);
    }
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stalled', checks: ['ci'] }),
    );
    t.watcher.dispose();
  });

  it('Given two stalled checks of different names, When they are read, Then each is rerun once', async () => {
    const t = setup(delivery());
    t.watcher.track('w1', ID);
    t.setChecks([stalled(1, 'lint'), stalled(2, 'build')]);
    await tick(CI_POLL_MS);
    t.setChecks([stalled(3, 'lint'), stalled(4, 'build')]);
    await tick(CI_POLL_MS);
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(2);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });
});

describe('a watcher that never follows blindly', () => {
  it('Given a request that left the read states, When its timer fires, Then it is not read and not followed', async () => {
    const t = setup(delivery());
    t.watcher.track('w1', ID);
    t.setState('merged');
    await tick(CI_POLL_MS * 3);
    expect(t.forge.prView).not.toHaveBeenCalled();
    t.watcher.dispose();
  });

  it('Given a closed PR and a hook that does not take it, When it is read again, Then the hook is asked again', async () => {
    const t = setup(delivery(), 'CLOSED');
    t.on.closed.mockReturnValueOnce(false).mockReturnValue(true);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    await tick(CI_POLL_MS);
    expect(t.on.closed).toHaveBeenCalledTimes(2);
    await tick(CI_POLL_MS * 3);
    expect(t.on.closed).toHaveBeenCalledTimes(2);
    t.watcher.dispose();
  });

  it('Given a foreign head and a hook that does not take it, When it is read again, Then the hook is asked again', async () => {
    const t = setup(delivery(), 'OPEN', FOREIGN);
    t.on.dropped.mockReturnValueOnce(false).mockReturnValue(true);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 2);
    expect(t.on.dropped).toHaveBeenCalledTimes(2);
    t.watcher.dispose();
  });

  it('Given commit statuses and no check run, When they are read, Then they are checks without a job', async () => {
    const t = setup(delivery());
    t.setStatuses([
      { context: 'ci/a', state: 'pending' },
      { context: 'ci/b', state: 'success' },
      { context: 'ci/c', state: 'failure' },
    ]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    expect(t.ci()?.checks.map((c) => [c.name, c.status, c.conclusion, c.job])).toEqual([
      ['ci/a', 'in_progress', null, null],
      ['ci/b', 'completed', 'success', null],
      ['ci/c', 'completed', 'failure', null],
    ]);
    expect(t.on.red).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });

  it('Given no check at all, When it is read twice, Then the wait is counted from the first read', async () => {
    const t = setup(delivery());
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    const first = t.ci()?.emptySince;
    expect(first).toBeTruthy();
    await tick(CI_POLL_MS);
    expect(t.ci()?.emptySince).toBe(first);
    t.watcher.dispose();
  });

  it('Given a stalled status, When it is read, Then it cannot be rerun and the user is alerted', async () => {
    const t = setup(delivery());
    t.setStatuses([{ context: 'ci/a', state: 'error' }]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    expect(t.forge.rerunJob).not.toHaveBeenCalled();
    t.watcher.dispose();
  });

  it('Given a rerun the forge refuses, When it is read again, Then the user is alerted without a second try', async () => {
    const t = setup(delivery());
    t.forge.rerunJob.mockRejectedValue(new Error('403'));
    t.setChecks([{ id: 5, name: 'ci', status: 'completed', conclusion: 'timed_out' }]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 3);
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });

  it('Given a forge that fails, When the checks cannot be read, Then the last reading is kept as unknown', async () => {
    const t = setup(delivery());
    t.forge.checkRuns.mockRejectedValue(new Error('503'));
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 2);
    expect(t.ci()?.verdict).toBe('unknown');
    t.watcher.dispose();
  });
});
