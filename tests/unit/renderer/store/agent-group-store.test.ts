import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Agent, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 US4 — the store follows an orchestrator closed with its agents, and its restart (FR-023 … FR-026).

const lead = agent(1, { role: 'orchestrator' });
const sub = (n: number) => agent(n, { launchedBy: lead.id });
const mine = agent(4);

const workspaceOf = (agents: Agent[]): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents,
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
  workflow: { lastValid: null, error: null, readAt: null },
  runs: [],
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

const setup = async (agents: Agent[]) => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn((channel: string) =>
    channel === 'app:getState'
      ? Promise.resolve({
          workspaces: [workspaceOf(agents)],
          recents: [],
          clis: [],
          permission: null,
        })
      : Promise.resolve(undefined),
  );
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
  const states = () =>
    Object.fromEntries(
      (store.getState().workspaces[0]?.agents ?? []).map((a) => [a.position, a.state]),
    );
  return { store, invoke, emit, states };
};

describe('closing an orchestrator', () => {
  it('keeping the worktrees, closes it and its agents but leaves the one of the user', async () => {
    const { store, invoke, states } = await setup([lead, sub(2), sub(3), mine]);
    store.getState().requestCloseAgent(lead.id);
    await store.getState().closeAgent(false);
    expect(invoke).toHaveBeenCalledWith('agent:close', { agentId: lead.id, removeWorktree: false });
    expect(states()).toEqual({ 1: 'closed', 2: 'closed', 3: 'closed', 4: 'awaiting-prompt' });
  });

  it('removing the worktrees, drops the orchestrator and its agents', async () => {
    const { store, states } = await setup([lead, sub(2), sub(3), mine]);
    store.getState().requestCloseAgent(lead.id);
    await store.getState().closeAgent(true);
    expect(states()).toEqual({ 4: 'awaiting-prompt' });
  });

  it('forgets a closed orchestrator and the agents closed with it', async () => {
    const closed = (a: Agent) => ({ ...a, state: 'closed' as const });
    const { store, states } = await setup([closed(lead), closed(sub(2)), mine]);
    store.getState().requestCloseAgent(lead.id);
    await store.getState().closeAgent(false);
    expect(states()).toEqual({ 4: 'awaiting-prompt' });
  });

  it('drops an orchestrator that launched nobody, as any agent', async () => {
    const { store, states } = await setup([lead, mine]);
    store.getState().requestCloseAgent(lead.id);
    await store.getState().closeAgent(false);
    expect(states()).toEqual({ 4: 'awaiting-prompt' });
  });

  it('closing a sub-agent drops only its tile', async () => {
    const { store, states } = await setup([lead, sub(2), sub(3)]);
    store.getState().requestCloseAgent(sub(2).id);
    await store.getState().closeAgent(false);
    expect(states()).toEqual({ 1: 'awaiting-prompt', 3: 'awaiting-prompt' });
  });
});

describe('the event of an agent closed', () => {
  it('keeps the tile, closed, when the agent is kept', async () => {
    const { emit, states } = await setup([lead, sub(2)]);
    emit('agent:state', { agentId: sub(2).id, state: 'closed', kept: true });
    expect(states()).toEqual({ 1: 'awaiting-prompt', 2: 'closed' });
  });

  it('drops the tile otherwise', async () => {
    const { emit, states } = await setup([lead, sub(2)]);
    emit('agent:state', { agentId: sub(2).id, state: 'closed' });
    expect(states()).toEqual({ 1: 'awaiting-prompt' });
  });
});

describe('restarting a closed agent', () => {
  it('asks first, then restarts with the choice made', async () => {
    const { store, invoke } = await setup([{ ...lead, state: 'closed' }]);
    store.getState().requestRestartAgent(lead.id);
    expect(store.getState().restartingAgentId).toBe(lead.id);
    await store.getState().confirmRestartAgent(false);
    expect(invoke).toHaveBeenCalledWith('agent:restart', { agentId: lead.id, resumeWork: false });
    expect(store.getState().restartingAgentId).toBeNull();
  });

  it('can be cancelled, and does nothing when no restart was asked', async () => {
    const { store, invoke } = await setup([{ ...lead, state: 'closed' }]);
    store.getState().requestRestartAgent(lead.id);
    store.getState().cancelRestartAgent();
    await store.getState().confirmRestartAgent(true);
    expect(invoke).not.toHaveBeenCalledWith('agent:restart', expect.anything());
  });

  it('restarts an agent in error with no option, as before', async () => {
    const { store, invoke } = await setup([{ ...lead, state: 'error' }]);
    await store.getState().restartAgent(lead.id);
    expect(invoke).toHaveBeenCalledWith('agent:restart', { agentId: lead.id });
  });
});
