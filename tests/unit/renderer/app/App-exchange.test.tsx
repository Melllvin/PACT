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
    deliveries: [],
    delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
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

describe('App, a PR to review', () => {
  const reviewing = (): Workspace => {
    const dev = agent(2, { state: 'done', role: 'dev', workspaceId: 'w1' });
    const head = 'abcdef0123456789abcdef0123456789abcdef01';
    return {
      ...looping(),
      agents: [dev],
      exchanges: { messages: [], escalations: [] },
      deliveries: [
        {
          id: uuid(90),
          agentId: dev.id,
          testAgentId: null,
          issueId: null,
          branch: 'feat/2',
          target: 'main',
          channel: 'github',
          unverified: true,
          title: 'Connexion',
          message: 'feat: connexion',
          frozenCommit: head,
          verdictCommit: null,
          pactCommits: [head],
          pushedHead: head,
          rebases: 0,
          state: 'reviewing',
          reason: null,
          pr: { number: 7, url: 'https://github.com/pact/test/pull/7', expectedAuthor: 'me' },
          ci: null,
          review: { required: true, refusedOnce: false },
          cleanup: 'none',
          requestedBy: 'orchestrator',
          at: '2026-11-09T10:00:00.000Z',
          updatedAt: '2026-11-09T10:00:00.000Z',
        },
      ],
    } as unknown as Workspace;
  };

  const open = () => {
    const invoke = vi.fn((channel: string) =>
      Promise.resolve(
        channel === 'app:getState'
          ? { workspaces: [reviewing()], recents: [], clis: [], permission: null }
          : undefined,
      ),
    );
    const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
    render(<App store={store} getPathForFile={() => ''} />);
    return { invoke, user: userEvent.setup() };
  };

  it('Given the item, When the user opens the PR, Then the main process is asked, by the delivery', async () => {
    const { invoke, user } = open();
    await user.click(await screen.findByRole('link', { name: 'Ouvrir la PR' }));
    expect(invoke).toHaveBeenCalledWith('delivery:openPr', { deliveryId: uuid(90) });
  });

  it('Given the item, When the user refuses with a reason, Then the reason travels with the decision', async () => {
    const { invoke, user } = open();
    await user.click(await screen.findByRole('button', { name: 'Refuser' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Motif du refus' }),
      ' Le cas vide manque. ',
    );
    await user.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(invoke).toHaveBeenCalledWith('delivery:decide', {
      deliveryId: uuid(90),
      decision: 'refuse',
      head: 'abcdef0123456789abcdef0123456789abcdef01',
      reason: 'Le cas vide manque.',
    });
  });
});
