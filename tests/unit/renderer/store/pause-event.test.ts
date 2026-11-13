import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { defaultDeliverySettings } from '../../../../src/shared/delivery';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 009 — the pause of an agent travels with its `agent:state` event; an event without it leaves it as it is.

const workspace: Workspace = {
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [agent(1)],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  testCommand: null,
  integrationRequests: [],
  delivery: defaultDeliverySettings(),
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
const pause = {
  cliId: 'claude-code',
  account: 'default',
  cause: 'threshold' as const,
  windows: [{ id: 'five-hour', label: '5 h', percent: 90, resetsAt: null }],
  resumeAt: null,
  pausedAt: '2030-01-01T09:00:00.000Z',
  midTurn: false,
  saved: false,
  closedQuestion: null,
  blocked: null,
};

describe('agent:state with a pause', () => {
  it('sets the pause, keeps it on an event without one, and clears it on null', async () => {
    const listeners: ((payload: unknown) => void)[] = [];
    const api = {
      invoke: vi.fn(() =>
        Promise.resolve({ workspaces: [workspace], recents: [], clis: [], permission: null }),
      ),
      on: (channel: string, listener: (payload: unknown) => void) => {
        if (channel === 'agent:state') listeners.push(listener);
        return () => undefined;
      },
    } as unknown as PactApi;
    const store = createAppStore(api);
    await store.getState().load();
    store.getState().connect();
    const emit = (payload: Record<string, unknown>) => {
      for (const l of listeners) l({ agentId: agent(1).id, ...payload });
    };
    const current = () => store.getState().workspaces[0]?.agents[0];

    emit({ state: 'paused', pause });
    expect(current()?.pause).toEqual(pause);
    emit({ state: 'paused' });
    expect(current()?.pause).toEqual(pause);
    emit({ state: 'starting', pause: null });
    expect(current()?.pause).toBeNull();
  });
});
