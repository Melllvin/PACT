import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../../../src/main/delivery/delivery-service';
import { GhFailure } from '../../../../src/main/delivery/gh-client';
import { isFinalState, type Delivery } from '../../../../src/shared/delivery';
import type { Integration } from '../../../../src/shared/review';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';

// 008 T018 — the edges of DeliveryService that the repositories of the integration tests do not
// reach: refusals of the barriers, odd errors of git and gh, the decisions of the local channel.
// Every dependency is a double; the real runs are in tests/integration/delivery.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const TEST = uuid(3);
const F = 'f'.repeat(40);
const R = 'a'.repeat(40);

const agentOf = (id: string, role: string, extra: object = {}) => ({
  id,
  role,
  state: 'done',
  branch: `feat/${role}`,
  baseBranch: 'main',
  worktreePath: `/wt/${role}`,
  ...extra,
});

const accepted = (extra: object = {}) => ({
  issueId: '0012-a',
  devAgentId: DEV,
  testAgentId: TEST,
  state: 'accepted',
  rounds: [
    {
      reports: [{ role: 'test', commit: F, verdict: { result: 'accepted' } }],
      proof: { commit: F },
    },
  ],
  ...extra,
});

type Over = {
  workspace?: Partial<Record<string, unknown>>;
  git?: Partial<Record<string, unknown>>;
  gh?: Partial<Record<string, unknown>>;
  loop?: unknown;
  factory?: boolean;
};

function setup(over: Over = {}) {
  let ws = {
    id: 'w1',
    path: '/repo',
    mainBranch: 'main',
    testCommand: 'npm test',
    testPaths: [...DEFAULT_TEST_PATHS],
    agents: [agentOf(LEAD, 'orchestrator'), agentOf(DEV, 'dev'), agentOf(TEST, 'test')],
    loops: [accepted()],
    issues: [],
    deliveries: [] as Delivery[],
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
    ...over.workspace,
  } as unknown as Workspace;
  const git = {
    revParse: vi.fn(() => Promise.resolve(F)),
    treeOf: vi.fn(() => Promise.resolve('tree')),
    mergeBase: vi.fn(() => Promise.resolve('base')),
    changedFiles: vi.fn(() => Promise.resolve([])),
    entry: vi.fn(() => Promise.resolve(null)),
    statusIgnored: vi.fn(() =>
      Promise.resolve({ modified: [] as string[], untracked: [] as string[] }),
    ),
    hasOrigin: vi.fn(() => Promise.resolve(true)),
    fetchRefs: vi.fn(() => Promise.resolve(true)),
    rebaseOnto: vi.fn(() => Promise.resolve({ commit: R, conflicts: [] })),
    pushBranch: vi.fn(() => Promise.resolve(true)),
    addDetached: vi.fn(() => Promise.resolve()),
    removeDetached: vi.fn(() => Promise.resolve()),
    moveWorktree: vi.fn(() => Promise.resolve()),
    ...over.git,
  };
  const gh = {
    availability: vi.fn(() => Promise.resolve({ ok: true, login: 'me' })),
    prCreate: vi.fn(() => Promise.resolve({ number: 7, url: 'https://x/pull/7' })),
    ...over.gh,
  };
  const loops = {
    get: vi.fn(() => over.loop ?? ws.loops[0]),
    reopen: vi.fn(() => Promise.resolve({ state: 'running', round: 2 })),
    deliveryState: vi.fn(() => Promise.resolve()),
  };
  const exchanges = { record: vi.fn((..._args: unknown[]) => Promise.resolve({})) };
  const integration = { start: vi.fn(() => Promise.resolve({})) };
  const runTests = vi.fn(() => Promise.resolve({ passed: true, tail: '' }));
  const service = new DeliveryService({
    workspaces: {
      get: (id: string) => (id === ws.id ? ws : undefined),
      list: () => [ws],
      update: (_id: string, change: (w: Workspace) => Workspace) => {
        ws = change(ws);
        return Promise.resolve(ws);
      },
    },
    git,
    gh: over.factory ? () => gh : gh,
    loops,
    integration,
    exchanges,
    deliveriesDir: '/nowhere/deliveries',
    runTests,
  } as unknown as DeliveryServiceDeps);
  const request = (extra: object = {}) =>
    service.request('w1', {
      agentId: DEV,
      title: 'Titre',
      message: 'feat: x',
      requestedBy: 'user',
      ...extra,
    } as never);
  const settle = async (id: string) => {
    await vi.waitFor(() => {
      const d = ws.deliveries.find((x) => x.id === id);
      expect(d && (isFinalState(d.state) || d.state === 'watching')).toBe(true);
    });
    return ws.deliveries.find((x) => x.id === id) as Delivery;
  };
  return {
    service,
    request,
    settle,
    git,
    gh,
    loops,
    exchanges,
    integration,
    runTests,
    ws: () => ws,
  };
}

const told = (s: ReturnType<typeof setup>) =>
  s.exchanges.record.mock.calls.map((c) => c[1] as { text: string });

describe('request: what it refuses before anything is written', () => {
  it('Given an unknown workspace or agent, When it is requested, Then NOT_FOUND', async () => {
    const s = setup();
    await expect(s.service.request('nope', { agentId: DEV } as never)).rejects.toThrow('Workspace');
    await expect(s.request({ agentId: uuid(9) })).rejects.toThrow('Agent introuvable');
  });

  it('Given a delivery under way, When another is asked, Then it is refused with its state', async () => {
    const s = setup({ git: { hasOrigin: vi.fn(() => Promise.resolve(false)) } });
    await s.request();
    const second = await s.request();
    expect(second.state).toBe('refused');
    expect(second.reason).toBe('Une livraison est déjà en cours (reviewing).');
  });

  it('Given a verdict without a commit, When it is requested, Then the verdict does not match the head', async () => {
    const s = setup({
      workspace: {
        loops: [
          accepted({ rounds: [{ reports: [{ role: 'test', verdict: { result: 'accepted' } }] }] }),
        ],
      },
    });
    const d = await s.request();
    expect(d.state).toBe('refused');
    expect(d.reason).toMatch(/Le verdict porte sur/);
  });

  it('Given a loop that is not accepted and no tester, When it is requested, Then it is refused', async () => {
    const s = setup({
      workspace: { loops: [accepted({ state: 'running' })], agents: [agentOf(DEV, 'dev')] },
    });
    expect((await s.request()).reason).toMatch(/n’est pas acceptée/);
  });
});

describe('request: tests the tester made and the dev does not hold', () => {
  it('Given a test file that differs, When it is requested, Then the dev is told how to fetch it', async () => {
    const s = setup({
      git: {
        changedFiles: vi.fn(() =>
          Promise.resolve([{ path: 'tests/a.test.ts' }, { path: 'src/a.ts' }]),
        ),
        entry: vi.fn((dir: string) =>
          Promise.resolve({ oid: dir === '/wt/test' ? '1' : '2', mode: '100644' }),
        ),
      },
    });
    const d = await s.request();
    expect(d.reason).toMatch(/Tests du testeur manquants : tests\/a.test.ts/);
    expect(told(s)[0]?.text).toContain('git checkout feat/test -- tests/a.test.ts');
  });

  it('Given no merge base at all, When it is requested, Then no file is missing', async () => {
    const s = setup({
      git: {
        mergeBase: vi.fn(() => Promise.reject(new Error('no base'))),
        rebaseOnto: vi.fn(() => Promise.resolve({ commit: R, conflicts: [] })),
      },
    });
    const d = await s.request();
    expect(d.state).toBe('checking');
    await s.settle(d.id);
    expect(s.git.entry).not.toHaveBeenCalled();
  });

  it('Given a tester on another base, When it is requested, Then that base is tried too', async () => {
    const s = setup({
      workspace: {
        agents: [
          agentOf(LEAD, 'orchestrator'),
          agentOf(DEV, 'dev'),
          agentOf(TEST, 'test', { baseBranch: 'dev' }),
        ],
      },
      git: { changedFiles: vi.fn(() => Promise.resolve([{ path: 'tests/a.test.ts' }])) },
    });
    await s.settle((await s.request()).id);
    expect(s.git.mergeBase).toHaveBeenCalledWith('/wt/test', 'HEAD', 'dev');
  });
});

describe('request: the choice of the channel and of the forge', () => {
  it('Given a gh per repository and a dev without a base, When it is requested, Then the main branch is the target', async () => {
    const s = setup({
      factory: true,
      workspace: {
        agents: [
          agentOf(LEAD, 'orchestrator'),
          agentOf(DEV, 'dev', { baseBranch: '' }),
          agentOf(TEST, 'test'),
        ],
      },
    });
    const d = await s.request();
    expect(d.target).toBe('main');
    expect((await s.settle(d.id)).state).toBe('watching');
  });

  it('Given gh unavailable, When it is requested, Then the remedy is the reason', async () => {
    const s = setup({
      gh: {
        availability: vi.fn(() =>
          Promise.resolve({ ok: false, reason: 'gh absent.', remedy: 'Installe gh.' }),
        ),
      },
    });
    const d = await s.request();
    expect(d.state).toBe('refused');
    expect(d.reason).toBe('gh absent. Installe gh.');
  });

  it('Given an unverified request without a loop, When it is local, Then it waits for the user', async () => {
    const s = setup({ git: { hasOrigin: vi.fn(() => Promise.resolve(false)) } });
    const d = await s.request({ unverified: true });
    expect(d).toMatchObject({
      channel: 'local',
      state: 'reviewing',
      testAgentId: null,
      issueId: null,
    });
    expect(s.loops.deliveryState).not.toHaveBeenCalled();
  });
});

describe('the steps on the forge', () => {
  const unverified = { unverified: true };

  it('Given a remote that does not answer, When the run fetches, Then the request is refused', async () => {
    const s = setup({ git: { fetchRefs: vi.fn(() => Promise.resolve(false)) } });
    const d = await s.settle((await s.request(unverified)).id);
    expect(d).toMatchObject({
      state: 'refused',
      reason: 'Le dépôt distant est injoignable (fetch).',
    });
  });

  it.each([
    [new Error('boum'), 'boum'],
    ['pas une erreur', 'erreur de git'],
  ])(
    'Given a rebase that throws %s, When the run goes on, Then it is conflicted with %s',
    async (thrown, why) => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error is the case
      const s = setup({ git: { rebaseOnto: vi.fn(() => Promise.reject(thrown)) } });
      const d = await s.settle((await s.request(unverified)).id);
      expect(d.state).toBe('conflicted');
      expect(d.reason).toContain(why);
      expect(told(s)[0]?.text).toMatch(/^Conflit au recalage/);
    },
  );

  it('Given conflicts, When the loop is reopened, Then the orchestrator hears of the round or of the ceiling', async () => {
    const s = setup({
      git: {
        rebaseOnto: vi.fn(() => Promise.resolve({ commit: null, conflicts: ['a.ts', 'b.ts'] })),
      },
    });
    await s.settle((await s.request()).id);
    expect(s.loops.reopen).toHaveBeenCalledWith(
      'w1',
      '0012-a',
      expect.stringContaining('a.ts, b.ts'),
    );
    expect(told(s)[0]?.text).toContain('tour 2 ouvert');

    s.loops.reopen.mockResolvedValue({ state: 'escalated', round: 4 });
    await s.settle((await s.request()).id);
    expect(told(s).at(-1)?.text).toContain('plafond atteint');
  });

  it('Given tests that fail, When there is a tail or not, Then the reason carries it or not', async () => {
    const s = setup();
    s.runTests.mockResolvedValueOnce({ passed: false, tail: 'FAIL a' });
    const first = await s.settle((await s.request(unverified)).id);
    expect(first).toMatchObject({ state: 'tests-failed' });
    expect(first.reason).toContain(': FAIL a');
    expect(s.git.removeDetached).toHaveBeenCalled();

    s.runTests.mockResolvedValueOnce({ passed: false, tail: '' });
    const second = await s.settle((await s.request(unverified)).id);
    expect(second.reason).toBe(`Tests rouges sur ${R.slice(0, 7)}`);
    expect(told(s).at(-1)?.text).toMatch(/^Tests rouges sur/);
  });

  it('Given no command of tests in the project, When the run goes on, Then the tests are skipped', async () => {
    const s = setup({ workspace: { testCommand: null } });
    const d = await s.settle((await s.request(unverified)).id);
    expect(d.state).toBe('watching');
    expect(s.runTests).not.toHaveBeenCalled();
  });

  it('Given a push that the remote refuses, When the run pushes, Then the request is refused', async () => {
    const s = setup({ git: { pushBranch: vi.fn(() => Promise.resolve(false)) } });
    const d = await s.settle((await s.request(unverified)).id);
    expect(d.reason).toContain('la branche distante a bougé');
  });

  it.each([
    [new GhFailure('refus de gh'), 'refus de gh'],
    [new Error('autre'), 'gh a échoué.'],
  ])(
    'Given gh that fails with %s, When the PR is opened, Then the reason is %s',
    async (error, reason) => {
      const s = setup({ gh: { prCreate: vi.fn(() => Promise.reject(error)) } });
      const d = await s.settle((await s.request(unverified)).id);
      expect(d).toMatchObject({ state: 'refused', reason });
    },
  );

  it('Given an error that is not one, When a step throws, Then the reason is generic; an error gives its message', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error is the case
    const s = setup({ git: { addDetached: vi.fn(() => Promise.reject('chaîne')) } });
    expect((await s.settle((await s.request(unverified)).id)).reason).toBe('Échec inattendu.');
    s.git.addDetached.mockRejectedValueOnce(new Error('disque plein'));
    expect((await s.settle((await s.request(unverified)).id)).reason).toBe('disque plein');
  });

  it('Given a commit that PACT did not make, When the run starts, Then the request drops, with or without a loop', async () => {
    const s = setup();
    s.git.revParse.mockResolvedValueOnce(F).mockResolvedValue('9'.repeat(40));
    const d = await s.settle((await s.request(unverified)).id);
    expect(d.state).toBe('dropped');
    expect(s.loops.deliveryState).not.toHaveBeenCalled();
    expect(told(s)[0]?.text).toMatch(/^Livraison tombée/);
  });

  it('Given an issue and a loop, When the run is refused or dropped, Then the loop goes back where it was', async () => {
    const s = setup({ git: { fetchRefs: vi.fn(() => Promise.resolve(false)) } });
    s.loops.get.mockReturnValue({ issueId: '0012-a', state: 'delivering' });
    await s.settle((await s.request()).id);
    expect(s.loops.deliveryState).toHaveBeenCalledWith('w1', '0012-a', 'accepted');

    s.git.fetchRefs.mockResolvedValue(true);
    s.git.revParse.mockResolvedValueOnce(F).mockResolvedValue('9'.repeat(40));
    await s.settle((await s.request()).id);
    expect(s.loops.deliveryState).toHaveBeenCalledWith('w1', '0012-a', 'running');
  });

  it('Given an idle dev, When the PR is open, Then its worktree moves to the rebased commit', async () => {
    const s = setup();
    await s.settle((await s.request(unverified)).id);
    expect(s.git.moveWorktree).toHaveBeenCalledWith('/wt/dev', R, 'tree');
  });

  it('Given a dev that moved meanwhile, When the PR is open, Then its worktree is left alone', async () => {
    const s = setup();
    // The request, the two checks of the run, then the look of the catch-up.
    s.git.revParse
      .mockResolvedValueOnce(F)
      .mockResolvedValueOnce(F)
      .mockResolvedValueOnce(F)
      .mockResolvedValue('9'.repeat(40));
    await s.settle((await s.request(unverified)).id);
    expect(s.git.moveWorktree).not.toHaveBeenCalled();
  });

  it('Given a journal that fails while the run ends, When the request is made, Then nothing is left unhandled', async () => {
    const s = setup({ git: { fetchRefs: vi.fn(() => Promise.resolve(false)) } });
    s.exchanges.record.mockRejectedValue(new Error('journal'));
    const d = await s.request(unverified);
    await vi.waitFor(() => {
      expect(s.exchanges.record).toHaveBeenCalled();
    });
    expect(s.ws().deliveries.find((x) => x.id === d.id)?.state).toBe('syncing');
    // The queue goes on: the next request is not blocked behind the failure.
    s.exchanges.record.mockResolvedValue({});
    s.git.fetchRefs.mockResolvedValue(true);
    expect((await s.request({ ...unverified, agentId: DEV })).state).toBe('refused');
  });
});

describe('the decisions of the local channel', () => {
  const local = { git: { hasOrigin: vi.fn(() => Promise.resolve(false)) } };
  const ask = async (s: ReturnType<typeof setup>) => (await s.request()).id;

  it('Given an unknown or a settled request, When it is decided, Then it is refused', async () => {
    const s = setup(local);
    await expect(
      s.service.decide({ deliveryId: uuid(9), decision: 'validate', head: F }),
    ).rejects.toThrow('introuvable');
    const github = setup();
    const id = (await github.request({ unverified: true })).id;
    await expect(
      github.service.decide({ deliveryId: id, decision: 'validate', head: F }),
    ).rejects.toThrow('n’attend pas');
  });

  it('Given a head that changed, When it is validated, Then the page is stale', async () => {
    const s = setup(local);
    const id = await ask(s);
    await expect(
      s.service.decide({ deliveryId: id, decision: 'validate', head: R }),
    ).rejects.toThrow('recharge');
  });

  it('Given a dev that is gone, When it is validated, Then NOT_FOUND', async () => {
    const s = setup(local);
    const id = await ask(s);
    await s.service['deps'].workspaces.update('w1', (w) => ({
      ...w,
      agents: w.agents.filter((a) => a.id !== DEV),
    }));
    await expect(
      s.service.decide({ deliveryId: id, decision: 'validate', head: F }),
    ).rejects.toThrow('Agent introuvable');
  });

  it('Given a refusal with or without a reason, When it is decided, Then the loop is released and the lead told', async () => {
    const s = setup(local);
    const d = await s.service.decide({
      deliveryId: await ask(s),
      decision: 'refuse',
      head: F,
      reason: 'non',
    });
    expect(d).toMatchObject({ state: 'user-refused', reason: 'non' });
    expect(s.loops.deliveryState).toHaveBeenCalledWith('w1', '0012-a', 'accepted');
    expect(told(s)[0]?.text).toContain('Fusion refusée');

    const lone = setup(local);
    const second = await lone.service.decide({
      deliveryId: (await lone.request({ unverified: true })).id,
      decision: 'refuse',
      head: F,
    });
    expect(second.reason).toBeNull();
    expect(lone.loops.deliveryState).not.toHaveBeenCalled();
  });

  it('Given a head that is not the frozen one, When it is validated, Then the request drops', async () => {
    const s = setup(local);
    const id = await ask(s);
    s.git.revParse.mockResolvedValue('9'.repeat(40));
    const d = await s.service.decide({ deliveryId: id, decision: 'validate', head: F });
    expect(d.state).toBe('dropped');
  });

  it('Given changes not committed, When it is validated, Then it is refused and stays to decide', async () => {
    const s = setup(local);
    const id = await ask(s);
    s.git.statusIgnored.mockResolvedValue({ modified: ['a.ts'], untracked: ['b.ts'] });
    await expect(
      s.service.decide({ deliveryId: id, decision: 'validate', head: F }),
    ).rejects.toThrow('a.ts, b.ts');
    expect(s.ws().deliveries[0]?.state).toBe('reviewing');
  });

  it.each([
    ['squash', 'squash'],
    ['merge', 'keep-commits'],
  ])(
    'Given the merge mode %s, When it is validated, Then the integration starts in %s',
    async (mergeMode, mode) => {
      const s = setup({ ...local, workspace: { delivery: { mergeMode } } });
      const d = await s.service.decide({ deliveryId: await ask(s), decision: 'validate', head: F });
      expect(d.state).toBe('merging');
      expect(s.integration.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode, requestId: d.id }),
      );
    },
  );

  it('Given an integration that does not start, When it is validated, Then the request is back to review', async () => {
    const s = setup(local);
    const id = await ask(s);
    s.integration.start.mockRejectedValue(new Error('occupé'));
    await expect(
      s.service.decide({ deliveryId: id, decision: 'validate', head: F }),
    ).rejects.toThrow('occupé');
    expect(s.ws().deliveries[0]?.state).toBe('reviewing');
  });

  it('Given a delivery that vanishes from the workspace, When it is read, Then NOT_FOUND', async () => {
    const s = setup(local);
    const id = await ask(s);
    const gone = { ...s.ws(), deliveries: [] };
    const list = vi.spyOn(s.service['deps'].workspaces, 'list').mockReturnValue([s.ws()]);
    vi.spyOn(s.service['deps'].workspaces, 'get').mockReturnValue(gone);
    await expect(s.service.decide({ deliveryId: id, decision: 'refuse', head: F })).rejects.toThrow(
      'Livraison introuvable',
    );
    list.mockRestore();
  });
});

describe('following the integration of a local merge', () => {
  const states = (state: Integration['state'], extra: Partial<Integration> = {}) =>
    ({ state, requestId: undefined, ...extra }) as Integration;

  const merging = async (unverified: boolean) => {
    const s = setup({ git: { hasOrigin: vi.fn(() => Promise.resolve(false)) } });
    const id = (await s.request(unverified ? { unverified } : {})).id;
    await s.service.decide({ deliveryId: id, decision: 'validate', head: F });
    return { s, id };
  };

  it('Given an integration without a request, When its state arrives, Then nothing happens', async () => {
    const { s } = await merging(false);
    s.service.integrationState(states('integrated'));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.ws().deliveries[0]?.state).toBe('merging');
  });

  it('Given an integration of an unknown request, When its state arrives, Then nothing happens', async () => {
    const { s } = await merging(false);
    s.service.integrationState(states('integrated', { requestId: uuid(9) }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.ws().deliveries[0]?.state).toBe('merging');
  });

  it.each([true, false])(
    'Given an integration that ends well (unverified=%s), When its state arrives, Then it is merged',
    async (unverified) => {
      const { s, id } = await merging(unverified);
      s.service.integrationState(states('integrated', { requestId: id }));
      await vi.waitFor(() => {
        expect(s.ws().deliveries[0]?.state).toBe('merged');
      });
      await vi.waitFor(() => {
        expect(s.loops.deliveryState).toHaveBeenCalledTimes(unverified ? 0 : 2);
        expect(told(s).at(-1)?.text).toContain(
          `Fusion locale · ${unverified ? 'feat/dev' : '0012-a'}`,
        );
      });
    },
  );

  it.each<[Partial<Integration>, string]>([
    [{ error: 'conflit' }, 'conflit'],
    [{}, 'L’intégration n’a pas abouti.'],
  ])(
    'Given an integration that fails with %j, When its state arrives, Then the request is back to review with %s',
    async (extra, reason) => {
      const { s, id } = await merging(false);
      s.service.integrationState(states('failed', { requestId: id, ...extra }));
      await vi.waitFor(() => {
        expect(s.ws().deliveries[0]?.reason).toBe(reason);
      });
      expect(s.ws().deliveries[0]?.state).toBe('reviewing');
      await vi.waitFor(() => {
        expect(told(s).at(-1)?.text).toContain('Fusion locale non faite');
      });
    },
  );

  it('Given an integration still running, When its state arrives, Then the request waits', async () => {
    const { s, id } = await merging(false);
    s.service.integrationState(states('merging' as never, { requestId: id }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.ws().deliveries[0]?.state).toBe('merging');
    s.service.dispose();
  });
});
