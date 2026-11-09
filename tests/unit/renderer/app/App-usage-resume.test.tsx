import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 009 US2 — « Reprendre » and « Annuler la reprise » of a « ◆ En pause » in À faire (contracts/ui.md).

const RESET = '2030-01-01T11:00:00.000Z';

const pausedWorkspace = (): Workspace =>
  ({
    id: 'w1',
    path: '/w1',
    name: 'w1',
    mainBranch: 'main',
    agents: [
      agent(2, {
        state: 'paused',
        workspaceId: 'w1',
        pause: {
          cliId: 'claude-code',
          account: '/comptes/a',
          cause: 'threshold',
          windows: [{ id: 'five-hour', label: '5 h', percent: 91, resetsAt: RESET }],
          resumeAt: RESET,
          pausedAt: '2030-01-01T09:00:00.000Z',
          midTurn: false,
          saved: true,
          closedQuestion: null,
          blocked: null,
        },
      }),
    ],
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

describe('App, a pause at a limit of consumption', () => {
  it.each([
    ['Reprendre', 'usage:resume'],
    ['Annuler la reprise', 'usage:cancelResume'],
  ] as const)(
    'Given a paused account in À faire, When the user chooses « %s », Then %s is sent for that account',
    async (label, channel) => {
      const invoke = vi.fn((requested: string) =>
        Promise.resolve(
          requested === 'app:getState'
            ? { workspaces: [pausedWorkspace()], recents: [], clis: [], permission: null }
            : undefined,
        ),
      );
      const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
      render(<App store={store} getPathForFile={() => ''} />);
      const item = await waitFor(() => {
        const found = document.querySelector<HTMLElement>('li[data-kind="usage-paused"]');
        if (!found) throw new Error('no « En pause » item yet');
        return found;
      });
      await userEvent.click(within(item).getByRole('button', { name: label }));
      expect(invoke).toHaveBeenCalledWith(channel, { cliId: 'claude-code', account: '/comptes/a' });
    },
  );
});
