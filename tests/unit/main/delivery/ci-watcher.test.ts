import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CiWatcher } from '../../../../src/main/delivery/ci-watcher';
import { CI_POLL_MS, FORGE_DOWN_MS, type Delivery } from '../../../../src/shared/delivery';
import type { Workspace } from '../../../../src/shared/model';

// 008 T024 — the CI watcher (research R9, FR-009, FR-010, FR-011, FR-016, SC-004): one timer per
// followed PR, no agent, a fake clock. Nothing real: the forge is a set of mocks.
//
// RED until T028 creates `src/main/delivery/ci-watcher.ts`.
//
// API fixed here for the dev (contracts/ and research.md are silent on the shape of the watcher; this
// is the simplest one, and every choice is listed in the report):
//
//   new CiWatcher({
//     workspaces,   // { get(id), list(), update(id, change) }: the watcher WRITES `delivery.ci` (the last
//                   //  CiStatus: verdict, checks, rerun, emptySince, failingSince, readAt) with `update`
//     forge,        // (workspaceId) => { prView, checkRuns, statuses, requiredChecks, rerunJob } (GhClient)
//     repo,         // (workspaceId) => Promise<'owner/name'>, the `<owner>/<repo>` of the API paths
//     workflows,    // (workspaceId, target) => Promise<boolean>: R10, a `.yml` under .github/workflows of
//                   //  origin/<target>; the watcher adds « the required checks are not empty »
//     on: {         // what the watcher found; the DeliveryService decides (Auto is read THERE, at that instant)
//       green({ workspaceId, deliveryId, ci }),                 // once per head, when the verdict turns green
//       red({ workspaceId, deliveryId, ci, failing: string[] }),// names of the failing checks
//       dropped({ workspaceId, deliveryId, head }),             // head of the PR ∉ pactCommits (FR-004)
//       alert({ workspaceId, deliveryId, reason: 'stalled' | 'forge-down', checks: string[] }),
//     },
//   })
//   track(workspaceId, deliveryId)  first read CI_POLL_MS (30 s) later, then every CI_POLL_MS
//   resume()                        every delivery `watching` of every workspace is read at once, then every 30 s
//   untrack(deliveryId)             no read any more
//   dispose()                       every timer stops
//   A read = `prView(pr.number)`, then (head ∈ pactCommits only) the checks of `headRefOid`: never those of
//   another commit. The id of a check run is the id of its job of GitHub Actions: it is what `rerunJob` gets.

const F = 'f'.repeat(40);
const R = 'a'.repeat(40);
const FOREIGN = 'b'.repeat(40);
const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const AGENT = '00000000-0000-4000-8000-000000000003';
const START = '2026-11-09T10:00:00.000Z';

const check = (conclusion: string | null, status = 'completed', id = 11, name = 'ci') => ({
  id,
  name,
  status,
  conclusion,
});

const delivery = (extra: Partial<Delivery> = {}): Delivery => ({
  id: ID,
  agentId: AGENT,
  source: 'agent',
  testAgentId: null,
  issueId: '0012-connexion',
  branch: 'feat/connexion',
  target: 'main',
  channel: 'github',
  unverified: false,
  title: 'Connexion',
  message: 'feat: connexion',
  frozenCommit: F,
  verdictCommit: R,
  pactCommits: [F, R],
  pushedHead: R,
  rebases: 0,
  state: 'watching',
  reason: null,
  pr: { number: 7, url: 'https://github.com/pact/test/pull/7', expectedAuthor: 'pact-user' },
  ci: null,
  review: { required: false, refusedOnce: false },
  cleanup: 'none',
  requestedBy: 'orchestrator',
  at: START,
  updatedAt: START,
  ...extra,
});

function setup(deliveries: Delivery[] = [delivery()]) {
  let ws = {
    id: 'w1',
    deliveries,
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
  } as unknown as Workspace;
  const workspaces = {
    get: (id: string) => (id === ws.id ? ws : undefined),
    list: () => [ws],
    update: vi.fn((_id: string, change: (w: Workspace) => Workspace) => {
      ws = change(ws);
      return Promise.resolve(ws);
    }),
  };
  const pr = { head: R, state: 'OPEN' };
  let checks = [check(null, 'in_progress')];
  let down = false;
  let checksDown = false;
  const forge = {
    prView: vi.fn(() => {
      if (down) return Promise.reject(new Error('HTTP 503'));
      return Promise.resolve({
        number: 7,
        state: pr.state,
        headRefOid: pr.head,
        headRefName: 'feat/connexion',
        author: { login: 'pact-user' },
        isCrossRepository: false,
        baseRefName: 'main',
        mergeStateStatus: 'CLEAN',
      });
    }),
    checkRuns: vi.fn(() =>
      checksDown ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(checks),
    ),
    statuses: vi.fn(() => Promise.resolve([])),
    requiredChecks: vi.fn(() => Promise.resolve(['ci'])),
    rerunJob: vi.fn(() => Promise.resolve()),
  };
  // What the DeliveryService does at the green: it reads Auto, at that very instant (FR-011).
  const autoAtGreen: boolean[] = [];
  const on = {
    green: vi.fn(() => {
      autoAtGreen.push(ws.delivery.auto);
    }),
    red: vi.fn(),
    dropped: vi.fn(),
    alert: vi.fn(),
  };
  const watcher = new CiWatcher({
    workspaces,
    forge: () => forge,
    repo: () => Promise.resolve('pact/test'),
    workflows: () => Promise.resolve(true),
    on,
  });
  return {
    watcher,
    forge,
    on,
    autoAtGreen,
    workspaces,
    current: () => (ws.deliveries.find((d) => d.id === ID) as Delivery).ci,
    setAuto: (auto: boolean) => {
      ws = { ...ws, delivery: { ...ws.delivery, auto } };
    },
    setChecks: (next: ReturnType<typeof check>[]) => {
      checks = next;
    },
    setHead: (head: string) => {
      pr.head = head;
    },
    setForgeDown: (value: boolean) => {
      down = value;
    },
    setChecksDown: (value: boolean) => {
      checksDown = value;
    },
  };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(START) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the rhythm of the reads', () => {
  it('Given a followed PR, When time passes, Then the PR and the checks of its head are read every 30 s, not before', async () => {
    const t = setup();
    t.watcher.track('w1', ID);

    await tick(CI_POLL_MS - 1);
    expect(t.forge.prView).not.toHaveBeenCalled();
    await tick(1);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);
    expect(t.forge.prView).toHaveBeenCalledWith(7);
    expect(t.forge.checkRuns).toHaveBeenCalledWith('pact/test', R);
    // The structure first, then the checks of the head it named.
    expect(t.forge.prView.mock.invocationCallOrder[0]).toBeLessThan(
      t.forge.checkRuns.mock.invocationCallOrder[0] ?? 0,
    );
    await tick(CI_POLL_MS);
    expect(t.forge.prView).toHaveBeenCalledTimes(2);
    await tick(CI_POLL_MS * 3);
    expect(t.forge.prView).toHaveBeenCalledTimes(5);
    t.watcher.dispose();
  });

  it('Given a read, When the checks are still running, Then the last reading is saved on the request and nothing is announced', async () => {
    const t = setup();
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);

    expect(t.current()).toMatchObject({
      head: R,
      verdict: 'pending',
      configured: true,
      required: ['ci'],
      checks: [{ id: 11, name: 'ci', status: 'in_progress', conclusion: null }],
    });
    expect(t.on.green).not.toHaveBeenCalled();
    expect(t.on.red).not.toHaveBeenCalled();
    expect(t.on.dropped).not.toHaveBeenCalled();
    expect(t.on.alert).not.toHaveBeenCalled();
    t.watcher.dispose();
  });

  it('Given a stopped follow or a disposed watcher, When time passes, Then nothing is read any more', async () => {
    const t = setup();
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    t.watcher.untrack(ID);
    await tick(CI_POLL_MS * 4);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);

    t.watcher.track('w1', ID);
    t.watcher.dispose();
    await tick(CI_POLL_MS * 4);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);
  });

  it('Given an app restarted with requests watching, When resume runs, Then each of them is read at once, and only those', async () => {
    const t = setup([
      delivery(),
      delivery({
        id: OTHER,
        state: 'watching',
        pr: { number: 8, url: 'u/8', expectedAuthor: 'p' },
      }),
      delivery({ id: '00000000-0000-4000-8000-000000000009', state: 'reviewing' }),
    ]);
    t.watcher.resume();
    await tick(0);

    expect(t.forge.prView).toHaveBeenCalledTimes(2);
    expect(t.forge.prView).toHaveBeenCalledWith(7);
    expect(t.forge.prView).toHaveBeenCalledWith(8);
    await tick(CI_POLL_MS);
    expect(t.forge.prView).toHaveBeenCalledTimes(4);
    t.watcher.dispose();
  });
});

describe('green, and Auto read at that instant (US2 sc.5, 6, SC-004)', () => {
  it('Given Auto off when the PR opened, When Auto is turned on and the checks then turn green, Then green is announced at that read and Auto reads on', async () => {
    const t = setup();
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 2);
    expect(t.on.green).not.toHaveBeenCalled();

    t.setAuto(true);
    await tick(CI_POLL_MS);
    expect(t.on.green).not.toHaveBeenCalled(); // Auto alone merges nothing: the CI is not green.

    t.setChecks([check('success')]);
    await tick(CI_POLL_MS);
    expect(t.on.green).toHaveBeenCalledTimes(1);
    const [green] = t.on.green.mock.calls[0] as unknown as [
      { workspaceId: string; deliveryId: string; ci: { head: string; verdict: string } },
    ];
    expect(green).toMatchObject({
      workspaceId: 'w1',
      deliveryId: ID,
      ci: { head: R, verdict: 'green' },
    });
    expect(t.autoAtGreen).toEqual([true]);
    t.watcher.dispose();
  });

  it('Given Auto on when the PR opened, When Auto is turned off and the checks then turn green, Then Auto reads off at the green', async () => {
    const t = setup();
    t.setAuto(true);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    t.setAuto(false);
    t.setChecks([check('success')]);
    await tick(CI_POLL_MS);

    expect(t.on.green).toHaveBeenCalledTimes(1);
    expect(t.autoAtGreen).toEqual([false]);
    t.watcher.dispose();
  });

  it('Given a green announced, When the checks stay green, Then it is not announced again for the same head', async () => {
    const t = setup();
    t.setChecks([check('success'), check('neutral', 'completed', 12, 'lint')]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 4);

    expect(t.on.green).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });

  it('Given a failing check, When it is read, Then red is announced with the names of the failing checks, never green', async () => {
    const t = setup();
    t.setChecks([
      check('failure', 'completed', 11, 'ci'),
      check('success', 'completed', 12, 'lint'),
    ]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);

    expect(t.on.red).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: ID, failing: ['ci'] }),
    );
    expect(t.on.green).not.toHaveBeenCalled();
    t.watcher.dispose();
  });
});

describe('a head that PACT did not make (US2 sc.2)', () => {
  it('Given checks green on the commit of PACT but a PR whose head is another one, When it is read, Then the request is dropped, no check of that head is read and nothing is green', async () => {
    const t = setup();
    t.setChecks([check('success')]); // green on R, which is no longer the head
    t.setHead(FOREIGN);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);

    expect(t.on.dropped).toHaveBeenCalledTimes(1);
    expect(t.on.dropped).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: ID, head: FOREIGN }),
    );
    expect(t.forge.checkRuns).not.toHaveBeenCalled();
    expect(t.on.green).not.toHaveBeenCalled();

    // A dropped request is not followed any more.
    await tick(CI_POLL_MS * 3);
    expect(t.forge.prView).toHaveBeenCalledTimes(1);
    expect(t.on.dropped).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });

  it('Given a head that is a commit of PACT (F or a rebased R), When it is read, Then the request is not dropped', async () => {
    const t = setup();
    t.setHead(F);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);

    expect(t.on.dropped).not.toHaveBeenCalled();
    expect(t.forge.checkRuns).toHaveBeenCalledWith('pact/test', F);
    t.watcher.dispose();
  });
});

describe('a check that stalls (US2 sc.9)', () => {
  it('Given a cancelled check, When it is read, Then its job is rerun once, then the user is alerted, with no round and no merge', async () => {
    const t = setup();
    t.setChecks([check('cancelled', 'completed', 42, 'ci')]);
    t.watcher.track('w1', ID);

    await tick(CI_POLL_MS);
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(1);
    expect(t.forge.rerunJob).toHaveBeenCalledWith('pact/test', 42);
    expect(t.current()?.rerun).toEqual([42]);
    expect(t.on.alert).not.toHaveBeenCalled(); // one rerun first

    // The rerun gave the same: the job is not rerun twice, the user is told.
    await tick(CI_POLL_MS);
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: ID, reason: 'stalled', checks: ['ci'] }),
    );

    // Said once. No round (red), no merge (green), no further rerun.
    await tick(CI_POLL_MS * 3);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    expect(t.forge.rerunJob).toHaveBeenCalledTimes(1);
    expect(t.on.red).not.toHaveBeenCalled();
    expect(t.on.green).not.toHaveBeenCalled();
    t.watcher.dispose();
  });

  it.each(['timed_out', 'stale'])(
    'Given a %s check, When it is read, Then it is rerun once like a cancelled one',
    async (conclusion) => {
      const t = setup();
      t.setChecks([check(conclusion, 'completed', 43, 'e2e')]);
      t.watcher.track('w1', ID);
      await tick(CI_POLL_MS);

      expect(t.forge.rerunJob).toHaveBeenCalledWith('pact/test', 43);
      t.watcher.dispose();
    },
  );

  it('Given a rerun that turns green, When it is read, Then green is announced and no alert was raised', async () => {
    const t = setup();
    t.setChecks([check('cancelled', 'completed', 42, 'ci')]);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);
    t.setChecks([check('success', 'completed', 42, 'ci')]);
    await tick(CI_POLL_MS);

    expect(t.on.green).toHaveBeenCalledTimes(1);
    expect(t.on.alert).not.toHaveBeenCalled();
    t.watcher.dispose();
  });
});

describe('a forge that does not answer', () => {
  it('Given a forge down, When the reads fail, Then the verdict is unknown and never green, and the alert comes after 10 minutes of failures in a row, once', async () => {
    const t = setup();
    t.setForgeDown(true);
    t.watcher.track('w1', ID);

    await tick(CI_POLL_MS); // first failed read, at 30 s
    expect(t.current()).toMatchObject({ verdict: 'unknown' });
    const since = t.current()?.failingSince;
    expect(since).toBe(new Date(Date.parse(START) + CI_POLL_MS).toISOString());

    await tick(FORGE_DOWN_MS - CI_POLL_MS); // 570 s of failures
    expect(t.on.alert).not.toHaveBeenCalled();
    await tick(CI_POLL_MS); // 600 s
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    expect(t.on.alert).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: ID, reason: 'forge-down' }),
    );
    await tick(CI_POLL_MS * 5);
    expect(t.on.alert).toHaveBeenCalledTimes(1);
    expect(t.on.green).not.toHaveBeenCalled();
    expect(t.forge.checkRuns).not.toHaveBeenCalled();
    t.watcher.dispose();
  });

  it('Given a forge that answers again, When the reads succeed, Then the failures are forgotten and green can come', async () => {
    const t = setup();
    t.setForgeDown(true);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS * 3);
    expect(t.current()?.failingSince).not.toBeNull();

    t.setForgeDown(false);
    t.setChecks([check('success')]);
    await tick(CI_POLL_MS);

    expect(t.current()).toMatchObject({ verdict: 'green', failingSince: null });
    expect(t.on.green).toHaveBeenCalledTimes(1);
    t.watcher.dispose();
  });

  it('Given a PR that is read but checks that are not, Then the verdict is unknown, never green', async () => {
    const t = setup();
    t.setChecksDown(true);
    t.watcher.track('w1', ID);
    await tick(CI_POLL_MS);

    expect(t.current()).toMatchObject({ verdict: 'unknown' });
    expect(t.on.green).not.toHaveBeenCalled();
    t.watcher.dispose();
  });
});
