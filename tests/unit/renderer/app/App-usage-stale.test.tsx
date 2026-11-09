import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import type { UsageState } from '../../../../src/shared/usage';
import { agent } from '../tiles/fixtures';

// 009 US3 — « Arrêter par prudence » and « Pas maintenant » of a « ◆ Limite … inconnue » in À faire, on the
// clock the main process tells (`usage:limit`): the renderer's own clock knows nothing of the test clock.

const workspace = (): Workspace =>
  ({
    id: 'w1',
    path: '/w1',
    name: 'w1',
    mainBranch: 'main',
    agents: [agent(2, { state: 'working', workspaceId: 'w1', cliId: 'claude-code' })],
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
    exchanges: { messages: [], escalations: [] },
    lastOpenedAt: '2026-11-08T10:00:00.000Z',
    status: 'available',
  }) as unknown as Workspace;

const readAt = '2030-01-01T09:00:00.000Z';
const state: UsageState = {
  cliId: 'claude-code',
  account: '/comptes/a',
  reading: {
    cliId: 'claude-code',
    account: '/comptes/a',
    readAt,
    windows: [
      {
        id: 'five-hour',
        label: '5 h',
        usedPercent: 82,
        resetsAt: '2030-01-01T14:00:00.000Z',
        minutes: 300,
      },
    ],
  },
  shares: [],
  level: 'ok',
};

const setup = () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const invoke = vi.fn((requested: string) =>
    Promise.resolve(
      requested === 'app:getState'
        ? { workspaces: [workspace()], recents: [], clis: [], permission: null }
        : requested === 'usage:get'
          ? [state]
          : undefined,
    ),
  );
  const api = {
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => undefined;
    },
  } as unknown as PactApi;
  const store = createAppStore(api);
  store.getState().connect();
  render(<App store={store} getPathForFile={() => ''} />);
  const item = () => document.querySelector<HTMLElement>('li[data-kind="usage-stale"]');
  const tell = (now: string) => {
    listeners.get('usage:limit')?.({ now, stops: {}, declined: [] });
  };
  return { invoke, item, tell, store };
};

describe('App, a reading too old', () => {
  it('offers nothing at 14 minutes of the clock of the main process, then the offer at 16', async () => {
    const { item, tell, store } = setup();
    await waitFor(() => {
      expect(Object.keys(store.getState().usage)).toHaveLength(1);
    });
    tell('2030-01-01T09:14:00.000Z');
    await waitFor(() => {
      expect(store.getState().usageLimit.clock).not.toBeNull();
    });
    expect(item()).toBeNull();
    tell('2030-01-01T09:16:00.000Z');
    await waitFor(() => {
      expect(item()?.textContent).toContain('Limite');
    });
    expect(item()?.textContent).toContain('inconnue depuis 16 min');
  });

  it.each([
    ['Arrêter par prudence', 'stop'],
    ['Pas maintenant', 'later'],
  ] as const)('sends usage:stale %s for that account', async (label, decision) => {
    const { invoke, item, tell } = setup();
    tell('2030-01-01T09:16:00.000Z');
    await waitFor(() => {
      expect(item()).not.toBeNull();
    });
    await userEvent.click(within(item() as HTMLElement).getByRole('button', { name: label }));
    expect(invoke).toHaveBeenCalledWith('usage:stale', {
      cliId: 'claude-code',
      account: '/comptes/a',
      decision,
    });
  });
});
