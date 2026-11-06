import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { IpcEvent, IpcEventChannel, PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 007 T009 — the store follows the journal of each workspace (workspace:exchanges, contracts/ui.md).

const workspace = (id: string): Workspace => ({
  id,
  path: `/${id}`,
  name: id,
  mainBranch: 'main',
  agents: [agent(1)],
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
  lastOpenedAt: '2026-11-06T10:00:00.000Z',
  status: 'available',
  exchanges: { messages: [], escalations: [] },
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const setup = async () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const api = {
    invoke: vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'app:getState'
          ? {
              workspaces: [workspace('w1'), workspace('w2')],
              recents: [],
              clis: [],
              permission: null,
            }
          : undefined,
      ),
    ),
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
  return { store, emit };
};

describe('the store follows workspace:exchanges', () => {
  const message = {
    id: uuid(10),
    at: '2026-11-06T10:00:00.000Z',
    from: 'pact',
    to: uuid(1),
    type: 'action' as const,
    kind: 'report' as const,
    text: 'Fait',
    unreadBy: [uuid(1)],
  };
  const escalation = {
    id: uuid(11),
    agents: [uuid(1), uuid(2)] as [string, string],
    lastMessageId: uuid(10),
    state: 'pending' as const,
    at: '2026-11-06T10:00:00.000Z',
  };

  it('keeps the messages and escalations of the workspace concerned, and only its own', async () => {
    const { store, emit } = await setup();
    emit('workspace:exchanges', {
      workspaceId: 'w1',
      exchanges: { messages: [message], escalations: [escalation] },
    });
    const [first, second] = store.getState().workspaces;
    expect(first?.exchanges.messages).toEqual([message]);
    expect(first?.exchanges.escalations).toEqual([escalation]);
    expect(second?.exchanges).toEqual({ messages: [], escalations: [] });
  });

  it('replaces the journal with the latest one, an escalation that is decided included', async () => {
    const { store, emit } = await setup();
    emit('workspace:exchanges', {
      workspaceId: 'w1',
      exchanges: { messages: [message], escalations: [escalation] },
    });
    emit('workspace:exchanges', {
      workspaceId: 'w1',
      exchanges: { messages: [message], escalations: [] },
    });
    expect(store.getState().workspaces[0]?.exchanges.escalations).toEqual([]);
  });

  it('ignores a journal of a workspace it does not know', async () => {
    const { store, emit } = await setup();
    emit('workspace:exchanges', {
      workspaceId: 'w9',
      exchanges: { messages: [message], escalations: [] },
    });
    expect(store.getState().workspaces.map((w) => w.exchanges.messages)).toEqual([[], []]);
  });
});
