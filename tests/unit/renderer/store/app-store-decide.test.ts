import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Agent, type Workspace } from '../../../../src/shared/model';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const agent = (n: number): Agent => ({
  id: uuid(n),
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/fake-${String(n)}`,
  worktreePath: `/repo/.worktrees/fake-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'starting',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  effort: null,
  launchedBy: null,
});

const workspace = (id: string, agents: Agent[]): Workspace => ({
  id,
  path: `/${id}`,
  name: id,
  mainBranch: 'main',
  agents,
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: null,
  integrationRequests: [],
  roleProfiles: {},
  issues: [],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

function fakeApi(state: { workspaces: Workspace[] }) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const api = {
    invoke: vi.fn(() => Promise.resolve({ recents: [], clis: [], permission: null, ...state })),
    on: (channel: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(listener);
      return () => listeners.get(channel)?.delete(listener);
    },
  } as unknown as PactApi;
  const emit = <C extends IpcEventChannel>(channel: C, payload: IpcEvent<C>) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };
  return { api, emit };
}

// fix-todo-diff-notifications — the last report of an agent, and a clicked notification.

describe('the last report of an agent', () => {
  it('is kept when it comes with a state, and dropped when the agent works again', async () => {
    const { api, emit } = fakeApi({ workspaces: [workspace('w1', [agent(1)])] });
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();

    emit('agent:state', {
      agentId: uuid(1),
      state: 'done',
      lastReport: { status: 'blocked', questions: ['Quelle base ?'] },
    });
    expect(store.getState().workspaces[0]?.agents[0]?.lastReport).toEqual({
      status: 'blocked',
      questions: ['Quelle base ?'],
    });
    emit('agent:state', { agentId: uuid(1), state: 'awaiting-prompt' });
    expect(store.getState().workspaces[0]?.agents[0]?.lastReport?.status).toBe('blocked');
    emit('agent:state', { agentId: uuid(1), state: 'working' });
    expect(store.getState().workspaces[0]?.agents[0]?.lastReport).toBeNull();
  });
});

describe('a clicked notification', () => {
  it('shows the workspace and asks its view to go to the agent', async () => {
    const { api, emit } = fakeApi({
      workspaces: [workspace('w1', [agent(1)]), workspace('w2', [agent(2)])],
    });
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();

    emit('workspace:agentsLaunched', { workspaceId: 'w2', focusAgentId: uuid(2) });

    expect(store.getState().activeTab).toEqual({ kind: 'workspace', id: 'w2' });
    expect(store.getState().focusRequest).toEqual({ workspaceId: 'w2', agentId: uuid(2) });
  });
});
