import { describe, expect, it, vi } from 'vitest';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../../../src/main/delivery/delivery-service';
import type { Delivery } from '../../../../src/shared/delivery';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';

// 010 T015 — at the PR stage, `request_delivery` is the delivery of 008, its barriers and its course
// unchanged (FR-015, US1 sc.3, research O7); only the merge mode comes from the stage (R9, FR-016).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DEV = uuid(2);
const HEAD = 'a'.repeat(40);
const ID = uuid(9);
const ISSUE = '0012-a';

const delivery = (extra: Partial<Delivery> = {}): Delivery => ({
  id: ID,
  agentId: DEV,
  source: 'agent',
  testAgentId: uuid(3),
  issueId: ISSUE,
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

function setup(mergeModeOf?: DeliveryServiceDeps['mergeModeOf'], request: Delivery = delivery()) {
  let ws = {
    id: 'w1',
    path: '/repo',
    mainBranch: 'main',
    testCommand: 'npm test',
    testPaths: [...DEFAULT_TEST_PATHS],
    agents: [{ id: uuid(1), role: 'orchestrator' }],
    loops: [],
    issues: [],
    deliveries: [request],
    delivery: {
      auto: true,
      mergeMode: 'squash',
      maxRounds: 3,
      polishPasses: 0,
      polishBrief: '',
    },
  } as unknown as Workspace;
  const gh = {
    availability: vi.fn(() => Promise.resolve({ ok: true, login: 'me' })),
    prView: vi.fn(() =>
      Promise.resolve({
        state: 'OPEN',
        headRefOid: HEAD,
        headRefName: 'feat/dev',
        baseRefName: 'main',
        author: { login: 'me' },
        isCrossRepository: false,
      }),
    ),
    prMerge: vi.fn(() => Promise.resolve()),
  };
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
    loops: {
      get: vi.fn(() => ({ issueId: ISSUE, state: 'delivering' })),
      reopen: vi.fn(() => Promise.resolve({ state: 'running', round: 2 })),
      deliveryState: vi.fn(() => Promise.resolve()),
    },
    integration: { start: vi.fn() },
    exchanges: { record: vi.fn(() => Promise.resolve({})) },
    agents: { close: vi.fn(() => Promise.resolve()) },
    pollMs: 3_600_000,
    deliveriesDir: '/nowhere',
    runTests: vi.fn(),
    ...(mergeModeOf ? { mergeModeOf } : {}),
  } as unknown as DeliveryServiceDeps);
  return { service, gh };
}

describe('the merge mode of the PR stage (010 R9, FR-016)', () => {
  it('Given a PR stage that merges by rebase, When Auto merges the PR, Then gh merges by rebase, with the head it checked', async () => {
    const mergeModeOf = vi.fn(() => 'rebase' as const);
    const s = setup(mergeModeOf);

    await s.service.settingsChanged('w1');

    await vi.waitFor(() => {
      expect(s.gh.prMerge).toHaveBeenCalledWith(7, 'rebase', HEAD);
    });
    expect(mergeModeOf).toHaveBeenCalledWith('w1', ISSUE);
    s.service.dispose();
  });

  it('Given no workflow dependency, When Auto merges the PR, Then the mode is the project’s as in 008 (SC-001)', async () => {
    const s = setup();

    await s.service.settingsChanged('w1');

    await vi.waitFor(() => {
      expect(s.gh.prMerge).toHaveBeenCalledWith(7, 'squash', HEAD);
    });
    s.service.dispose();
  });

  it('Given a request without an issue, When Auto merges the PR, Then the stage is asked with no issue', async () => {
    const mergeModeOf = vi.fn(() => 'merge' as const);
    // The branch of an agent out of any loop: the same service, the same merge.
    const s = setup(mergeModeOf, delivery({ issueId: null }));

    await s.service.settingsChanged('w1');

    await vi.waitFor(() => {
      expect(s.gh.prMerge).toHaveBeenCalledWith(7, 'merge', HEAD);
    });
    expect(mergeModeOf).toHaveBeenCalledWith('w1', null);
    s.service.dispose();
  });
});
