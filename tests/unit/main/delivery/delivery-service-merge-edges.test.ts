import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../../../src/main/delivery/delivery-service';
import { GhFailure } from '../../../../src/main/delivery/gh-client';
import type { Delivery } from '../../../../src/shared/delivery';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';

// 008 T029 — the edges of the CI and of the merge that the repositories of the integration tests do
// not reach: a restart in the middle of a merge, the odd answers of the forge before a merge, the
// failures of a hook. Every dependency is a double.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEV = uuid(2);
const TEST = uuid(3);
const HEAD = 'a'.repeat(40);
const ID = uuid(9);

const delivery = (extra: Partial<Delivery> = {}): Delivery => ({
  id: ID,
  agentId: DEV,
  source: 'agent',
  testAgentId: TEST,
  issueId: '0012-a',
  branch: 'feat/dev',
  target: 'main',
  channel: 'github',
  unverified: false,
  title: 'Titre',
  message: 'feat: x',
  frozenCommit: HEAD,
  verdictCommit: HEAD,
  pactCommits: [HEAD],
  pushedHead: HEAD,
  rebases: 0,
  state: 'reviewing',
  reason: null,
  pr: { number: 7, url: 'https://x/pull/7', expectedAuthor: 'me' },
  ci: {
    head: HEAD,
    configured: true,
    checks: [],
    required: null,
    verdict: 'green',
    emptySince: null,
    failingSince: null,
    rerun: [],
    readAt: '2026-01-01T00:00:00.000Z',
  },
  review: { required: false, refusedOnce: false },
  cleanup: 'none',
  requestedBy: 'user',
  at: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const view = (extra: object = {}) => ({
  state: 'OPEN',
  headRefOid: HEAD,
  headRefName: 'feat/dev',
  baseRefName: 'main',
  author: { login: 'me' },
  isCrossRepository: false,
  ...extra,
});

function setup(
  d: Delivery = delivery(),
  over: { gh?: Record<string, unknown>; loops?: Record<string, unknown>; auto?: boolean } = {},
) {
  let ws = {
    id: 'w1',
    path: '/repo',
    mainBranch: 'main',
    testCommand: 'npm test',
    testPaths: [...DEFAULT_TEST_PATHS],
    agents: [{ id: uuid(1), role: 'orchestrator' }],
    loops: [],
    issues: [],
    deliveries: [d],
    delivery: {
      auto: over.auto ?? true,
      mergeMode: 'squash',
      maxRounds: 3,
      polishPasses: 0,
      polishBrief: '',
    },
  } as unknown as Workspace;
  const gh = {
    availability: vi.fn(() => Promise.resolve({ ok: true, login: 'me' })),
    prView: vi.fn(() => Promise.resolve(view())),
    prMerge: vi.fn(() => Promise.resolve()),
    ...over.gh,
  };
  const loops = {
    get: vi.fn(() => ({ issueId: '0012-a', state: 'delivering' })),
    reopen: vi.fn(() => Promise.resolve({ state: 'running', round: 2 })),
    deliveryState: vi.fn(() => Promise.resolve()),
    ...over.loops,
  };
  const exchanges = { record: vi.fn((..._args: unknown[]) => Promise.resolve({})) };
  const agents = { close: vi.fn(() => Promise.resolve()) };
  const service = new DeliveryService({
    workspaces: {
      get: (id: string) => (id === ws.id ? ws : undefined),
      list: () => [ws],
      update: (_id: string, change: (w: Workspace) => Workspace) => {
        ws = change(ws);
        return Promise.resolve(ws);
      },
    },
    git: { hasWorkflows: vi.fn(() => Promise.resolve(false)) },
    gh,
    loops,
    integration: { start: vi.fn() },
    exchanges,
    agents,
    pollMs: 3_600_000,
    deliveriesDir: '/nowhere',
    runTests: vi.fn(),
  } as unknown as DeliveryServiceDeps);
  const current = () => ws.deliveries[0] as Delivery;
  const told = () =>
    exchanges.record.mock.calls.map(
      (call) => (call[1] as { delivery?: { outcome: string }; text?: string }).delivery?.outcome,
    );
  const texts = () =>
    exchanges.record.mock.calls.map((call) => (call[1] as { text?: string }).text ?? '');
  return { service, gh, loops, agents, current, told, texts, exchanges };
}

type Hooks = {
  onGreen(w: string, id: string): Promise<void>;
  onRed(w: string, id: string, failing: string[]): Promise<void>;
  onDropped(w: string, id: string, head: string): Promise<boolean>;
  onAlert(w: string, id: string, reason: string, checks: string[]): Promise<void>;
  onClosedOnForge(w: string, id: string, state: string): Promise<void>;
};
const hooks = (s: { service: DeliveryService }) => s.service as unknown as Hooks;

describe('resume after a restart', () => {
  it('a merge that went through on the forge ends as merged', async () => {
    const s = setup(delivery({ state: 'merging' }), {
      gh: { prView: vi.fn(() => Promise.resolve(view({ state: 'MERGED' }))) },
    });
    await s.service.resume();
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });

  it('a merge that did not leave goes back to watching', async () => {
    const s = setup(delivery({ state: 'merging' }), {
      gh: { prView: vi.fn(() => Promise.resolve(view())) },
    });
    await s.service.resume();
    expect(s.current().state).toBe('watching');
    s.service.dispose();
  });

  it('a PR closed meanwhile ends closed-on-forge', async () => {
    const s = setup(delivery({ state: 'merging' }), {
      gh: { prView: vi.fn(() => Promise.resolve(view({ state: 'CLOSED' }))) },
    });
    await s.service.resume();
    expect(s.current().state).toBe('closed-on-forge');
    expect(s.told()).toContain('alert');
    s.service.dispose();
  });

  it('a forge that does not answer goes back to watching', async () => {
    const s = setup(delivery({ state: 'merging' }), {
      gh: { prView: vi.fn(() => Promise.reject(new GhFailure('hors ligne'))) },
    });
    await s.service.resume();
    expect(s.current().state).toBe('watching');
    s.service.dispose();
  });

  it.each(['reviewing', 'merge-failed'] as const)(
    'a %s request is read again after a restart: a PR merged meanwhile ends merged',
    async (state) => {
      const s = setup(delivery({ state }), {
        gh: { prView: vi.fn(() => Promise.resolve(view({ state: 'MERGED' }))) },
      });
      await s.service.resume();
      await vi.waitFor(() => {
        expect(s.current().state).toBe('merged');
      });
      s.service.dispose();
    },
  );

  it('leaves alone a request that is not merging', async () => {
    const s = setup(delivery({ state: 'reviewing' }));
    await s.service.resume();
    expect(s.gh.prView).not.toHaveBeenCalled();
    expect(s.current().state).toBe('reviewing');
    s.service.dispose();
  });
});

describe('the hooks of the watcher', () => {
  it('tell the user of a stalled check, once named', async () => {
    const s = setup(delivery({ state: 'watching' }));
    await hooks(s).onAlert('w1', ID, 'stalled', ['build']);
    await hooks(s).onAlert('w1', ID, 'forge-down', []);
    expect(s.texts()[0]).toContain('« build »');
    expect(s.texts()[1]).toContain('la forge ne répond plus');
    s.service.dispose();
  });

  it('ignore an alert for a request that is gone or finished', async () => {
    const s = setup(delivery({ state: 'merged' }));
    await hooks(s).onAlert('w1', ID, 'stalled', []);
    await hooks(s).onAlert('w1', uuid(77), 'stalled', []);
    expect(s.exchanges.record).not.toHaveBeenCalled();
    s.service.dispose();
  });

  it('a PR merged by someone else ends as merged', async () => {
    const s = setup(delivery({ state: 'watching' }));
    await hooks(s).onClosedOnForge('w1', ID, 'MERGED');
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });

  it('a PR closed by someone else ends closed-on-forge', async () => {
    const s = setup(delivery({ state: 'watching' }));
    await hooks(s).onClosedOnForge('w1', ID, 'CLOSED');
    expect(s.current().state).toBe('closed-on-forge');
    s.service.dispose();
  });

  it('ignore a close of a request that is finished', async () => {
    const s = setup(delivery({ state: 'merged' }));
    await hooks(s).onClosedOnForge('w1', ID, 'CLOSED');
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });

  it('green and red ignore a request that is gone or not followed', async () => {
    const s = setup(delivery({ state: 'merge-failed' }));
    for (const id of [ID, uuid(77)]) {
      await hooks(s).onGreen('w1', id);
      await hooks(s).onRed('w1', id, ['ci']);
      await hooks(s).onDropped('w1', uuid(77), HEAD);
    }
    expect(s.current().state).toBe('merge-failed');
    expect(s.exchanges.record).not.toHaveBeenCalled();
    s.service.dispose();
  });

  it('a foreign head drops a failed merge too, and a finished request is left alone', async () => {
    const failed = setup(delivery({ state: 'merge-failed' }));
    await hooks(failed).onDropped('w1', ID, 'b'.repeat(40));
    expect(failed.current().state).toBe('dropped');
    expect(failed.told()).toContain('dropped');
    const done = setup(delivery({ state: 'merged' }));
    await hooks(done).onDropped('w1', ID, 'b'.repeat(40));
    expect(done.current().state).toBe('merged');
    failed.service.dispose();
    done.service.dispose();
  });

  it('green on a local request does nothing', async () => {
    const s = setup(delivery({ channel: 'local', state: 'watching' }));
    await hooks(s).onGreen('w1', ID);
    expect(s.current().state).toBe('watching');
    s.service.dispose();
  });

  it('green on a request already in review asks nothing twice', async () => {
    const s = setup(
      delivery({ state: 'reviewing', review: { required: true, refusedOnce: false } }),
    );
    await hooks(s).onGreen('w1', ID);
    expect(s.exchanges.record).not.toHaveBeenCalled();
    s.service.dispose();
  });
});

describe('what is read again before a merge (FR-031)', () => {
  const refused = async (d: Delivery, gh: Record<string, unknown>, text: string) => {
    const s = setup(d, { gh });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    expect(s.gh.prMerge).not.toHaveBeenCalled();
    expect(s.current().reason).toContain(text);
    s.service.dispose();
  };

  it('the branches of the PR changed', async () => {
    await refused(
      delivery(),
      { prView: vi.fn(() => Promise.resolve(view({ headRefName: 'other' }))) },
      'branches',
    );
  });

  it('the green read is not on the head', async () => {
    await refused(
      delivery({ ci: { ...(delivery().ci as object), head: 'b'.repeat(40) } as never }),
      {},
      'CI verte',
    );
  });

  it('the verdict is not on the head', async () => {
    await refused(delivery({ verdictCommit: 'c'.repeat(40) }), {}, 'verdict');
  });

  it('gh is no longer usable', async () => {
    await refused(
      delivery(),
      { availability: vi.fn(() => Promise.resolve({ ok: false, reason: 'déconnecté' })) },
      'déconnecté',
    );
  });

  it('a request of the workflow (no agent) tells the lead without an « about »', async () => {
    const s = setup(delivery({ agentId: null, source: 'workflow', verdictCommit: 'c'.repeat(40) }));
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    const said = s.exchanges.record.mock.calls.map((call) => call[1] as object);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ kind: 'delivery', delivery: { outcome: 'alert' } });
    expect(said[0]).not.toHaveProperty('about');
    s.service.dispose();
  });

  it('a PR closed on the forge at the recheck ends closed-on-forge', async () => {
    const s = setup(delivery(), {
      gh: { prView: vi.fn(() => Promise.resolve(view({ state: 'CLOSED' }))) },
    });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('closed-on-forge');
    });
    s.service.dispose();
  });

  it('a hook that fails after the merge leaves merge-failed with its message', async () => {
    const s = setup(delivery(), {
      loops: { deliveryState: vi.fn(() => Promise.reject(new Error('disque plein'))) },
    });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    expect(s.current().reason).toBe('disque plein');
    s.service.dispose();
  });

  it('a failure with an empty message is kept as it is', async () => {
    const s = setup(delivery(), {
      loops: {
        deliveryState: vi.fn(() =>
          Promise.reject(Object.assign(new Error('boom'), { message: '' })),
        ),
      },
    });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    expect(s.current().reason).toBe('');
    s.service.dispose();
  });

  it('a refusal of the forge that is not a GhFailure is told in general terms', async () => {
    const s = setup(delivery(), {
      gh: { prMerge: vi.fn(() => Promise.reject(new Error('x'))) },
    });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    expect(s.current().reason).toBe('gh a échoué.');
    s.service.dispose();
  });
});

describe('the end of a request', () => {
  it('a red CI of an unverified PR sends nobody back', async () => {
    const s = setup(delivery({ state: 'watching', unverified: true, issueId: null }));
    await hooks(s).onRed('w1', ID, ['ci']);
    expect(s.loops.reopen).not.toHaveBeenCalled();
    expect(s.current().state).toBe('ci-red');
    s.service.dispose();
  });

  it('a red CI reaching the ceiling escalates', async () => {
    const s = setup(delivery({ state: 'watching' }), {
      loops: { reopen: vi.fn(() => Promise.resolve({ state: 'escalated', round: 4 })) },
    });
    await hooks(s).onRed('w1', ID, ['ci']);
    expect(s.texts().at(-1)).toContain('plafond atteint');
    s.service.dispose();
  });

  it('merging an unverified PR closes nobody', async () => {
    const s = setup(delivery({ unverified: true, issueId: null, verdictCommit: null }));
    await s.service.settingsChanged('w1');
    expect(s.current().state).toBe('reviewing');
    await hooks(s).onClosedOnForge('w1', ID, 'MERGED');
    expect(s.current().state).toBe('merged');
    expect(s.agents.close).not.toHaveBeenCalled();
    s.service.dispose();
  });

  it('an agent that cannot close does not undo the merge', async () => {
    const s = setup(delivery({ state: 'watching' }));
    s.agents.close.mockRejectedValue(new Error('déjà fermé'));
    await hooks(s).onClosedOnForge('w1', ID, 'MERGED');
    expect(s.agents.close).toHaveBeenCalledTimes(2);
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });
});

describe('the inner edges', () => {
  type Inner = {
    watcher: {
      deps: {
        on: Record<string, (found: object) => Promise<void>>;
        repo(w: string): Promise<string>;
      };
    };
    merge(w: string, id: string): Promise<void>;
    mergeNow(w: string, id: string): Promise<void>;
    merged(w: string, id: string): Promise<void>;
  };
  const inner = (s: { service: DeliveryService }) => s.service as unknown as Inner;

  it('wires the alert and the close of the watcher to the service', async () => {
    const s = setup(delivery({ state: 'watching' }));
    const found = { workspaceId: 'w1', deliveryId: ID };
    await inner(s).watcher.deps.on.alert?.({ ...found, reason: 'stalled', checks: ['ci'] });
    expect(s.told()).toContain('alert');
    await inner(s).watcher.deps.on.closed?.({ ...found, state: 'CLOSED' });
    expect(s.current().state).toBe('closed-on-forge');
    s.service.dispose();
  });

  it('reads the repository once, and fails when gh is unusable', async () => {
    const s = setup(delivery(), {
      gh: { availability: vi.fn(() => Promise.resolve({ ok: false, reason: 'pas de gh' })) },
    });
    await expect(inner(s).watcher.deps.repo('w1')).rejects.toThrow('pas de gh');
    s.service.dispose();
  });

  it('never merges twice at once, and a close waits for the merge in progress', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup(delivery(), {
      gh: {
        prMerge: vi.fn(async () => {
          await gate;
        }),
      },
    });
    const first = inner(s).merge('w1', ID);
    await vi.waitFor(() => {
      expect(s.gh.prMerge).toHaveBeenCalled();
    });
    await inner(s).merge('w1', ID);
    await hooks(s).onClosedOnForge('w1', ID, 'CLOSED');
    expect(s.gh.prMerge).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });

  it('a foreign head during a merge in progress is left to the watcher, which asks again', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = setup(delivery(), {
      gh: {
        prMerge: vi.fn(async () => {
          await gate;
        }),
      },
    });
    const merging = inner(s).merge('w1', ID);
    await vi.waitFor(() => {
      expect(s.gh.prMerge).toHaveBeenCalled();
    });
    expect(await hooks(s).onDropped('w1', ID, 'b'.repeat(40))).toBe(false);
    release();
    await merging;
    expect(await hooks(s).onDropped('w1', ID, 'b'.repeat(40))).toBe(true);
    expect(s.current().state).toBe('merged');
    s.service.dispose();
  });

  it('a merge of a request that is gone tells nobody', async () => {
    const s = setup(delivery());
    await inner(s).merge('w1', uuid(77));
    expect(s.exchanges.record).not.toHaveBeenCalled();
    s.service.dispose();
  });

  it('a merge of a request that left the follow does nothing', async () => {
    const local = setup(delivery({ channel: 'local' }));
    await inner(local).mergeNow('w1', ID);
    const done = setup(delivery({ state: 'merged' }));
    await inner(done).mergeNow('w1', ID);
    expect(local.gh.prView).not.toHaveBeenCalled();
    expect(done.gh.prView).not.toHaveBeenCalled();
    local.service.dispose();
    done.service.dispose();
  });

  it('a failure that is not an Error is told in general terms', async () => {
    const s = setup(delivery(), {
      loops: {
        deliveryState: vi.fn(() => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'boom';
        }),
      },
    });
    await s.service.settingsChanged('w1');
    await vi.waitFor(() => {
      expect(s.current().state).toBe('merge-failed');
    });
    expect(s.current().reason).toBe('Échec inattendu.');
    s.service.dispose();
  });

  it('merged is said once, with no pushed head and no tester', async () => {
    const s = setup(delivery({ pushedHead: null, testAgentId: null, state: 'watching' }));
    await inner(s).merged('w1', ID);
    await inner(s).merged('w1', ID);
    expect(s.agents.close).toHaveBeenCalledTimes(1);
    expect(s.told().filter((outcome) => outcome === 'merged')).toHaveLength(1);
    s.service.dispose();
  });
});
