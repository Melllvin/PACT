import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 phase 7b — promoting an agent and renaming it, in the store (#45, #46).

const workspace: Workspace = {
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [agent(1), agent(2)],
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
};

const setup = async (fail?: string) => {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'app:getState') {
      return Promise.resolve({ workspaces: [workspace], recents: [], clis: [], permission: null });
    }
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (channel === fail) return Promise.reject({ code: 'INVALID_INPUT', message: 'Refusé' });
    return Promise.resolve(undefined);
  });
  const api = { invoke, on: () => () => undefined } as unknown as PactApi;
  const store = createAppStore(api);
  await store.getState().load();
  return { store, invoke };
};

const first = agent(1).id;

describe('promoting and renaming an agent', () => {
  it('gives the orchestrator role to the agent alone', async () => {
    const { store, invoke } = await setup();
    await store.getState().promoteAgent(first);
    expect(invoke).toHaveBeenCalledWith('orchestrator:promote', { agentId: first });
    const [one, two] = store.getState().workspaces[0]?.agents ?? [];
    expect(one?.role).toBe('orchestrator');
    expect(two?.role).toBe(agent(2).role);
  });

  it('shows why a promotion is refused and keeps the roles', async () => {
    const { store } = await setup('orchestrator:promote');
    await store.getState().promoteAgent(first);
    expect(store.getState().actionError).toBe('Refusé');
    expect(store.getState().workspaces[0]?.agents[0]?.role).toBe(agent(1).role);
  });

  it('keeps the trimmed name of the agent, and only for that agent', async () => {
    const { store, invoke } = await setup();
    await store.getState().renameAgent(first, '  Alice  ');
    expect(invoke).toHaveBeenCalledWith('agent:rename', { agentId: first, name: '  Alice  ' });
    const [one, two] = store.getState().workspaces[0]?.agents ?? [];
    expect(one?.name).toBe('Alice');
    expect(two?.name).toBe(agent(2).name);
  });

  it('shows why a name is refused and keeps the old one', async () => {
    const { store } = await setup('agent:rename');
    await store.getState().renameAgent(first, 'Bob');
    expect(store.getState().actionError).toBe('Refusé');
    expect(store.getState().workspaces[0]?.agents[0]?.name).toBe(agent(1).name);
  });
});
