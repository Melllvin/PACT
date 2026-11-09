import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Agent, type Workspace } from '../../../../src/shared/model';
import { deriveTodos } from '../../../../src/shared/todo';

// 008 T037 — what the renderer sends and shows for a PR to review (US3, contracts/ui.md `delivery:decide`).
//
// RED until T040. Assumed API: `decideDelivery(deliveryId, decision, head, reason?)` sends
// `delivery:decide` with exactly `{ deliveryId, decision, head }`, and `reason` when there is one;
// `deriveTodos` gives the item `delivery-review` of a PR of the forge `{ delivery: { id, head, url,
// verdict } }`, `head` being the head PACT pushed (the one `delivery:decide` expects), `url` the link
// of the PR and `verdict` `'accepted'` (or `null` for a PR without a verdict).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const REBASED = '0123456789abcdef0123456789abcdef01234567';
const DELIVERY = uuid(90);

const agent = (n: number): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `feat/${String(n)}`,
  worktreePath: `/repo/.worktrees/fake-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'done',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: 'dev',
  effort: null,
  launchedBy: null,
  closedWhileWorking: false,
});

const delivery = (overrides: Record<string, unknown> = {}) => ({
  id: DELIVERY,
  agentId: uuid(1),
  testAgentId: uuid(2),
  issueId: '0012-connexion',
  branch: 'feat/1',
  target: 'main',
  channel: 'github',
  unverified: false,
  title: 'Connexion',
  message: 'feat: connexion',
  frozenCommit: HEAD,
  verdictCommit: HEAD,
  pactCommits: [HEAD],
  pushedHead: HEAD,
  rebases: 0,
  state: 'reviewing',
  reason: null,
  pr: { number: 7, url: 'https://github.com/pact/test/pull/7', expectedAuthor: 'pact-user' },
  ci: null,
  review: { required: false, refusedOnce: false },
  cleanup: 'none',
  requestedBy: 'orchestrator',
  at: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
  ...overrides,
});

const workspace = (deliveries: unknown[] = []): Workspace =>
  ({
    id: 'w1',
    path: '/w1',
    name: 'w1',
    mainBranch: 'main',
    agents: [agent(1)],
    freeTerminals: [],
    quickLaunchCounters: { freeTerminal: 0 },
    permissionOverride: null,
    testCommand: null,
    integrationRequests: [],
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
    deliveries,
    roleProfiles: {},
    issues: [],
    loops: [],
    testPaths: [...DEFAULT_TEST_PATHS],
    publishRequests: [],
    exchanges: { messages: [], escalations: [] },
    lastOpenedAt: '2026-11-09T10:00:00.000Z',
    status: 'available',
  }) as unknown as Workspace;

function fakeApi(workspaces: Workspace[]) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'delivery:decide'
        ? delivery()
        : { recents: [], clis: [], permission: null, workspaces },
    ),
  );
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
  } as unknown as PactApi;
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  return { api, invoke, emit };
}

const names = () => 'Fake';

describe('the item « Relire la PR » carries what the decision needs', () => {
  it('Given a PR under review, When the items are derived, Then the item gives the delivery, the head PACT pushed, the link and the verdict', () => {
    const items = deriveTodos(
      workspace([delivery({ frozenCommit: HEAD, pushedHead: REBASED })]),
      names,
    );

    const review = items.filter((t) => t.kind === 'delivery-review');
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({
      id: `${DELIVERY}:delivery-review`,
      delivery: {
        id: DELIVERY,
        head: REBASED,
        url: 'https://github.com/pact/test/pull/7',
        verdict: 'accepted',
      },
    });
    expect(review[0]?.title).toContain('Relire la PR #7');
  });

  it('Given a PR without a verdict, When the items are derived, Then the item says so and carries no verdict', () => {
    const items = deriveTodos(
      workspace([
        delivery({ unverified: true, verdictCommit: null, testAgentId: null, issueId: null }),
      ]),
      names,
    );

    const [review] = items.filter((t) => t.kind === 'delivery-review');
    expect(review?.title).toContain('sans verdict');
    expect(review?.delivery).toMatchObject({ id: DELIVERY, head: HEAD, verdict: null });
  });

  it('Given a PR that is merged, refused or whose CI turned red, When the items are derived, Then there is no item', () => {
    for (const state of [
      'merging',
      'merged',
      'user-refused',
      'ci-red',
      'dropped',
      'closed-on-forge',
    ]) {
      const items = deriveTodos(workspace([delivery({ state })]), names);
      expect(items.filter((t) => t.kind === 'delivery-review')).toEqual([]);
    }
  });
});

describe('decideDelivery', () => {
  it('Given the head shown, When the user validates, Then delivery:decide carries the delivery, the decision and that head', async () => {
    const { api, invoke } = fakeApi([workspace([delivery()])]);
    const store = createAppStore(api);
    await store.getState().load();

    await store.getState().decideDelivery(DELIVERY, 'validate', HEAD);

    expect(invoke).toHaveBeenCalledWith('delivery:decide', {
      deliveryId: DELIVERY,
      decision: 'validate',
      head: HEAD,
    });
  });

  it('Given a reason, When the user refuses, Then delivery:decide carries the reason too', async () => {
    const { api, invoke } = fakeApi([workspace([delivery()])]);
    const store = createAppStore(api);
    await store.getState().load();

    const decide: (
      id: string,
      decision: 'validate' | 'refuse',
      head: string,
      reason?: string,
    ) => Promise<void> = store.getState().decideDelivery;
    await decide(DELIVERY, 'refuse', HEAD, 'Le cas vide manque.');

    expect(invoke).toHaveBeenCalledWith('delivery:decide', {
      deliveryId: DELIVERY,
      decision: 'refuse',
      head: HEAD,
      reason: 'Le cas vide manque.',
    });
  });

  it('Given a refusal by the main process, When the user validates, Then the reason is shown and the store keeps working', async () => {
    const { api, invoke } = fakeApi([workspace([delivery()])]);
    const store = createAppStore(api);
    await store.getState().load();
    // IPC failures reach the renderer as plain { code, message } objects.
    invoke.mockImplementationOnce(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      Promise.reject({ code: 'INVALID_INPUT', message: 'La tête a changé : recharge.' }),
    );

    await store.getState().decideDelivery(DELIVERY, 'validate', HEAD);

    expect(store.getState().actionError).toContain('La tête a changé');
  });

  it('Given the deliveries sent by the main process, When one is decided, Then the item disappears with the state it changes to', async () => {
    const { api, emit } = fakeApi([workspace([delivery()])]);
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();
    const before = store.getState().workspaces[0];
    expect(deriveTodos(before as Workspace, names).some((t) => t.kind === 'delivery-review')).toBe(
      true,
    );

    emit('workspace:deliveries', {
      workspaceId: 'w1',
      deliveries: [delivery({ state: 'merging' })] as never,
      delivery: workspace().delivery,
    });

    const after = store.getState().workspaces[0];
    expect(deriveTodos(after as Workspace, names).some((t) => t.kind === 'delivery-review')).toBe(
      false,
    );
  });
});
