import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 007 US3 — the user decides on two agents that loop, from À faire (FR-006).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const looping = (): Workspace => {
  const dev = agent(2, { state: 'done', role: 'dev', workspaceId: 'w1' });
  const spec = agent(3, { state: 'done', role: 'spec', workspaceId: 'w1' });
  return {
    id: 'w1',
    path: '/w1',
    name: 'w1',
    mainBranch: 'main',
    agents: [dev, spec],
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
    exchanges: {
      messages: [],
      escalations: [
        {
          id: uuid(50),
          agents: [dev.id, spec.id],
          lastMessageId: uuid(60),
          state: 'pending',
          at: '2026-11-08T10:00:00.000Z',
        },
      ],
    },
    lastOpenedAt: '2026-11-08T10:00:00.000Z',
    status: 'available',
  } as unknown as Workspace;
};

describe('App, an exchange in a loop', () => {
  it.each([
    ['Laisser reprendre', 'resume'],
    ['Couper', 'cut'],
  ] as const)(
    'Given an escalation in À faire, When the user chooses « %s », Then the decision %s is sent for that workspace',
    async (label, decision) => {
      const invoke = vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'app:getState'
            ? { workspaces: [looping()], recents: [], clis: [], permission: null }
            : undefined,
        ),
      );
      const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
      render(<App store={store} getPathForFile={() => ''} />);
      await userEvent.click(await screen.findByRole('button', { name: label }));
      expect(invoke).toHaveBeenCalledWith('exchange:decide', {
        workspaceId: 'w1',
        escalationId: uuid(50),
        decision,
      });
    },
  );
});
