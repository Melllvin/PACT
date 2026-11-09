import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import type { Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';
import { DEFAULT_TEST_PATHS } from '../../../../src/shared/model';

// US3 — the tile actions in the store: answer, resume, restart, « Journal », closing (T074, T078).

type Invoke = (channel: string, input?: unknown) => Promise<unknown>;

const workspace: Workspace = {
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [agent(1, { state: 'error' }), agent(2)],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: null,
  integrationRequests: [],
  delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
  deliveries: [],
  roleProfiles: {},
  issues: [],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  exchanges: { messages: [], escalations: [] },
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
};

// Another open workspace, untouched by what happens to the agents of the first one.
const other: Workspace = { ...workspace, id: 'w2', path: '/w2', name: 'w2', agents: [agent(3)] };

const setup = async (fail?: string) => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn<Invoke>((channel) => {
    if (channel === 'app:getState') {
      return Promise.resolve({
        workspaces: [workspace, other],
        recents: [],
        clis: [],
        permission: null,
      });
    }
    // IPC failures reach the renderer as plain { code, message } objects.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (channel === fail) return Promise.reject({ code: 'INVALID_INPUT', message: 'Refusé' });
    if (channel === 'agent:log') return Promise.resolve('Erreur simulée');
    return Promise.resolve(undefined);
  });
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  } as unknown as PactApi;
  const store = createAppStore(api);
  store.getState().connect();
  await store.getState().load();
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    listeners.get(channel)?.(payload);
  };
  return { store, invoke, emit };
};

const id = agent(1).id;

describe('agent actions', () => {
  // 003 T040–T044 — the journal of the orchestrator's actions and withdrawing its role.
  it('follows the orchestrator’s journal, and withdraws its role from the agent', async () => {
    const { store, invoke, emit } = await setup();
    const action = {
      id: '00000000-0000-4000-8000-0000000000b1',
      at: '2026-09-24T10:00:00.000Z',
      tool: 'send_prompt' as const,
      agentId: agent(2).id,
      summary: 'Écris la fonction',
      outcome: 'ok' as const,
      reason: null,
    };
    emit('orchestrator:action', { orchestratorId: id, ...action });
    emit('orchestrator:action', {
      orchestratorId: id,
      ...action,
      id: action.id.replace('b1', 'b2'),
    });
    expect(store.getState().orchestratorActions[id]?.map((a) => a.id)).toEqual([
      action.id.replace('b1', 'b2'),
      action.id,
    ]);

    invoke.mockResolvedValueOnce([action]);
    await store.getState().loadOrchestratorActions(id);
    expect(invoke).toHaveBeenCalledWith('orchestrator:actions', { agentId: id });
    expect(store.getState().orchestratorActions[id]).toEqual([action]);

    await store.getState().revokeOrchestrator(id);
    expect(invoke).toHaveBeenCalledWith('orchestrator:revoke', { agentId: id });
    const [first, second] = store.getState().workspaces[0]?.agents ?? [];
    expect(first?.role).toBeNull();
    expect(second).toEqual(workspace.agents[1]);
  });

  // 004 T016 — the role profiles of one workspace, the others untouched.
  it('sets the role profiles of its workspace alone', async () => {
    const { store, invoke } = await setup();
    const profiles = {
      dev: { cliId: 'claude-code', model: 'grand', effort: null, maxModel: null, escalate: false },
    };
    await store.getState().setRoleProfiles('w2', profiles);
    expect(invoke).toHaveBeenCalledWith('roles:setProfiles', { workspaceId: 'w2', profiles });
    const [first, second] = store.getState().workspaces;
    expect(first?.roleProfiles).toEqual({});
    expect(second?.roleProfiles).toEqual(profiles);
  });

  it('sends the answer, « Reprendre » and « Relancer » to the main process', async () => {
    const { store, invoke } = await setup();
    await store.getState().answerAgent(id, 'allow');
    await store.getState().resumeAgent(id);
    await store.getState().restartAgent(id);
    expect(invoke).toHaveBeenCalledWith('agent:answer', { agentId: id, answer: 'allow' });
    expect(invoke).toHaveBeenCalledWith('agent:resume', { agentId: id });
    expect(invoke).toHaveBeenCalledWith('agent:restart', { agentId: id });
    expect(store.getState().actionError).toBeNull();
  });

  // 003 T036, migrated by 008 T023 — « Livrer » and the decision on a local merge.
  it('requests a delivery and decides a merge, and follows the deliveries of the workspace', async () => {
    const { store, invoke, emit } = await setup('delivery:decide');
    const deliveryId = '00000000-0000-4000-8000-0000000000a1';
    const head = 'abcdef0123456789abcdef0123456789abcdef01';
    await store
      .getState()
      .requestDelivery('w1', id, { title: 'Connexion', message: 'feat: x', unverified: false });
    expect(invoke).toHaveBeenCalledWith('delivery:request', {
      workspaceId: 'w1',
      agentId: id,
      title: 'Connexion',
      message: 'feat: x',
      unverified: false,
    });
    await store.getState().decideDelivery(deliveryId, 'refuse', head);
    expect(store.getState().actionError).toBe('Refusé');

    const settings = {
      auto: true,
      mergeMode: 'squash' as const,
      maxRounds: 3,
      polishPasses: 0,
      polishBrief: '',
    };
    emit('workspace:deliveries', {
      workspaceId: 'w1',
      deliveries: [],
      delivery: settings,
      hasOrigin: true,
    });
    emit('workspace:deliveries', { workspaceId: 'w2', deliveries: [], delivery: settings });
    const [first, second] = store.getState().workspaces;
    expect(first).toMatchObject({ hasOrigin: true, delivery: settings });
    expect(second?.hasOrigin).toBeUndefined();
  });

  it('follows the loops and their reports, and sends the user’s decision (004 US2)', async () => {
    const { store, invoke, emit } = await setup();
    const issue = {
      id: '0012-connexion',
      title: 'Connexion',
      path: '.pact/issues/0012-connexion.md',
      state: 'escalated' as const,
      remote: null,
      trace: { branch: null, agents: [], pr: null },
    };
    emit('workspace:loops', { workspaceId: 'w1', loops: [], issues: [issue] });
    const [first, second] = store.getState().workspaces;
    expect(first?.issues).toEqual([issue]);
    expect(second?.issues).toEqual([]);

    for (const summary of ['un', 'deux']) {
      emit('orchestrator:report', { workspaceId: 'w1', agentId: id, kind: 'report', summary });
    }
    expect(store.getState().loopReports.w1?.map((r) => r.summary)).toEqual(['un', 'deux']);

    await store.getState().decideLoop('w1', '0012-connexion', 'restart');
    expect(invoke).toHaveBeenCalledWith('loop:decide', {
      workspaceId: 'w1',
      issueId: '0012-connexion',
      decision: 'restart',
    });
  });

  it('follows the issues and answers a request to publish them (004 US3)', async () => {
    const { store, invoke, emit } = await setup();
    const requestId = '6f1c2a4e-8b3d-4e5f-9a7b-1c2d3e4f5a6b';
    const request = { id: requestId, issueIds: ['0012'], requestedAt: '2026-11-03T00:00:00.000Z' };
    emit('workspace:issues', { workspaceId: 'w1', issues: [], publishRequests: [request] });
    const [first, second] = store.getState().workspaces;
    expect(first?.publishRequests).toEqual([request]);
    expect(second?.publishRequests).toEqual([]);

    await store.getState().confirmPublish(requestId);
    expect(invoke).toHaveBeenCalledWith('publishRequest:confirm', { requestId });
    await store.getState().refusePublish(requestId);
    expect(invoke).toHaveBeenCalledWith('publishRequest:refuse', { requestId });
  });

  it('cancels the scheduled resume (FR-036)', async () => {
    const { store, invoke } = await setup();
    await store.getState().cancelAutoResume(id);
    expect(invoke).toHaveBeenCalledWith('agent:cancelAutoResume', { agentId: id });
  });

  it('sends « Toujours pour ce worktree » with the answer (FR-034)', async () => {
    const { store, invoke } = await setup();
    await store.getState().answerAgent(id, 'allow', true);
    expect(invoke).toHaveBeenCalledWith('agent:answer', {
      agentId: id,
      answer: 'allow',
      always: true,
    });
  });

  it('shows a refused action until the next one succeeds', async () => {
    const { store } = await setup('agent:resume');
    await store.getState().resumeAgent(id);
    expect(store.getState().actionError).toBe('Refusé');
    await store.getState().restartAgent(id);
    expect(store.getState().actionError).toBeNull();
  });

  it('opens and closes « Journal » with the output kept by the main process', async () => {
    const { store, invoke } = await setup();
    await store.getState().openLog(id);
    expect(invoke).toHaveBeenCalledWith('agent:log', { agentId: id });
    expect(store.getState().log).toEqual({ agentId: id, text: 'Erreur simulée' });
    store.getState().closeLog();
    expect(store.getState().log).toBeNull();
  });

  it('reports a « Journal » that cannot be read', async () => {
    const { store } = await setup('agent:log');
    await store.getState().openLog(id);
    expect(store.getState().log).toBeNull();
    expect(store.getState().actionError).toBe('Refusé');
  });
});

describe('closing an agent (FR-037)', () => {
  it('asks first, then closes with the choice made and drops the tile', async () => {
    const { store, invoke } = await setup();
    store.getState().requestCloseAgent(id);
    expect(store.getState().closingAgentId).toBe(id);
    await store.getState().closeAgent(true);
    expect(invoke).toHaveBeenCalledWith('agent:close', { agentId: id, removeWorktree: true });
    expect(store.getState().closingAgentId).toBeNull();
    expect(store.getState().workspaces[0]?.agents.map((a) => a.id)).toEqual([agent(2).id]);
  });

  it('can be cancelled, and does nothing when no close was asked', async () => {
    const { store, invoke } = await setup();
    store.getState().requestCloseAgent(id);
    store.getState().cancelCloseAgent();
    await store.getState().closeAgent(false);
    expect(invoke).not.toHaveBeenCalledWith('agent:close', expect.anything());
  });

  it('keeps the tile and shows why when the close fails', async () => {
    const { store } = await setup('agent:close');
    store.getState().requestCloseAgent(id);
    await store.getState().closeAgent(false);
    expect(store.getState().workspaces[0]?.agents).toHaveLength(2);
    expect(store.getState().closingAgentId).toBeNull();
    expect(store.getState().actionError).toBe('Refusé');
  });

  it('drops the tile of an agent announced closed', async () => {
    const { store, emit } = await setup();
    emit('agent:state', { agentId: agent(2).id, state: 'closed' });
    expect(store.getState().workspaces[0]?.agents.map((a) => a.id)).toEqual([id]);
    expect(store.getState().workspaces[1]).toEqual(other);
  });
});

describe('« vu » in the review (002 T022, FR-009, FR-011)', () => {
  const blob = 'b'.repeat(40);
  const seen = (store: Awaited<ReturnType<typeof setup>>['store']) =>
    store.getState().workspaces[0]?.agents[0]?.review.seen;

  it('marks the content shown as seen, then forgets it', async () => {
    const { store, invoke } = await setup();
    await store.getState().markSeen(id, 'src/a.ts', blob);
    expect(invoke).toHaveBeenCalledWith('review:setSeen', {
      agentId: id,
      path: 'src/a.ts',
      seen: true,
    });
    expect(seen(store)).toEqual({ 'src/a.ts': blob });
    await store.getState().markSeen(id, 'src/a.ts', null);
    expect(invoke).toHaveBeenLastCalledWith('review:setSeen', {
      agentId: id,
      path: 'src/a.ts',
      seen: false,
    });
    expect(seen(store)).toEqual({});
  });

  it('leaves « vu » as it was when the main process refuses', async () => {
    const { store } = await setup('review:setSeen');
    await store.getState().markSeen(id, 'src/a.ts', blob);
    expect(seen(store)).toEqual({});
    expect(store.getState().actionError).toBe('Refusé');
  });
});

describe('comments and prompts of the review (002 T038, FR-012…FR-015)', () => {
  const comments = (store: Awaited<ReturnType<typeof setup>>['store']) =>
    store.getState().workspaces[0]?.agents[0]?.review.comments;
  const saved = {
    id: '00000000-0000-4000-8000-0000000000c1',
    path: 'src/a.ts',
    line: 3,
    text: 'Renommer.',
    createdAt: '2026-10-30T10:00:00.000Z',
    treated: false,
  };

  it('comments a line and keeps the comment returned with the agent', async () => {
    const { store, invoke } = await setup();
    invoke.mockImplementation((channel) =>
      Promise.resolve(channel === 'review:comment' ? saved : undefined),
    );
    await store.getState().commentLine(id, 'src/a.ts', 3, 'Renommer.');
    expect(invoke).toHaveBeenCalledWith('review:comment', {
      agentId: id,
      path: 'src/a.ts',
      line: 3,
      text: 'Renommer.',
    });
    expect(comments(store)).toEqual([saved]);
    expect(store.getState().correcting[id]).toBe('queued');
  });

  it('marks the comments treated once « Corriger les commentaires » is sent', async () => {
    const { store, invoke } = await setup();
    invoke.mockImplementation((channel) =>
      Promise.resolve(channel === 'review:comment' ? saved : undefined),
    );
    await store.getState().commentLine(id, 'src/a.ts', 3, 'Renommer.');
    await store.getState().sendToAgent(id, 'fix-comments');
    expect(invoke).toHaveBeenLastCalledWith('review:send', { agentId: id, kind: 'fix-comments' });
    expect(comments(store)?.map((c) => c.treated)).toEqual([true]);
  });

  it('sends a request written in the Décision column', async () => {
    const { store, invoke } = await setup();
    await store.getState().sendToAgent(id, 'request', 'Ajoute un test.');
    expect(invoke).toHaveBeenLastCalledWith('review:send', {
      agentId: id,
      kind: 'request',
      text: 'Ajoute un test.',
    });
  });

  it('follows the correction: working after a prompt, over once the agent is ready again', async () => {
    const { store, emit } = await setup();
    await store.getState().sendToAgent(id, 'conflict');
    expect(store.getState().correcting[id]).toBe('queued');
    // Ready while the prompt waits for its turn: the correction has not started yet.
    emit('agent:state', { agentId: id, state: 'done' });
    expect(store.getState().correcting[id]).toBe('queued');
    emit('agent:state', { agentId: id, state: 'working' });
    expect(store.getState().correcting[id]).toBe('working');
    emit('agent:state', { agentId: id, state: 'done' });
    expect(store.getState().correcting[id]).toBeUndefined();
  });

  it('shows why a prompt was refused, and follows nothing', async () => {
    const { store } = await setup('review:send');
    await store.getState().sendToAgent(id, 'failing-tests');
    expect(store.getState().actionError).toBe('Refusé');
    expect(store.getState().correcting[id]).toBeUndefined();
  });
});

describe('prompts of the orchestrator (003 T019)', () => {
  it('marks the agent from the prompt typed until it is ready again', async () => {
    const { store, emit } = await setup();
    emit('orchestrator:prompted', { agentId: id });
    expect(store.getState().orchestratorPrompted[id]).toBe('queued');
    emit('agent:state', { agentId: id, state: 'working' });
    expect(store.getState().orchestratorPrompted[id]).toBe('working');
    emit('agent:state', { agentId: id, state: 'done' });
    expect(store.getState().orchestratorPrompted[id]).toBeUndefined();
  });
});

// 007 T043 — « Laisser reprendre » / « Couper »: the store asks the main process by exchange:decide,
// as decideLoop does for loop:decide (contracts/ui.md « IPC »).
//
// API fixed here for the dev (see the report, « API fixées »):
//   state.decideExchange(workspaceId, escalationId, decision: 'resume' | 'cut'): Promise<void>
describe('deciding an exchange in a loop (007)', () => {
  type Decider = {
    decideExchange: (w: string, e: string, d: 'resume' | 'cut') => Promise<void>;
  };
  const escalationId = '00000000-0000-4000-8000-0000000000e1';

  it.each(['resume', 'cut'] as const)(
    'calls exchange:decide with the workspace, the escalation and « %s »',
    async (decision) => {
      const { store, invoke } = await setup();
      await (store.getState() as unknown as Decider).decideExchange('w1', escalationId, decision);
      expect(invoke).toHaveBeenCalledWith('exchange:decide', {
        workspaceId: 'w1',
        escalationId,
        decision,
      });
    },
  );

  it('shows why when the main process refuses, until the next action succeeds', async () => {
    const { store } = await setup('exchange:decide');
    await (store.getState() as unknown as Decider).decideExchange('w1', escalationId, 'cut');
    expect(store.getState().actionError).toBe('Refusé');
    await store.getState().restartAgent(id);
    expect(store.getState().actionError).toBeNull();
  });
});
