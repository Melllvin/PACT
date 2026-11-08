import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../../../src/renderer/app/App';
import { createAppStore } from '../../../../src/renderer/store/app-store';
import type { PactApi } from '../../../../src/shared/ipc';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 phase 7 — « Faire orchestrateur » and « Renommer » from the ⋮ menu reach the main process.

const solo = (): Workspace => ({
  id: 'w1',
  path: '/w1',
  name: 'w1',
  mainBranch: 'main',
  agents: [agent(1, { workspaceId: 'w1' })],
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
});

const launch = async () => {
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(
      channel === 'app:getState'
        ? {
            workspaces: [solo()],
            recents: [],
            clis: [
              {
                id: 'claude-code',
                name: 'Claude Code',
                adapter: 'claude-code',
                command: 'claude',
                resolvedPath: '/bin/claude',
                version: '1',
                origin: 'detected',
                status: 'installed',
                modelTiers: [],
                models: [],
              },
            ],
            permission: null,
          }
        : undefined,
    ),
  );
  const store = createAppStore({ invoke, on: () => () => undefined } as unknown as PactApi);
  render(<App store={store} getPathForFile={() => ''} />);
  const tile = await screen.findByRole('article');
  const user = userEvent.setup();
  await user.click(within(tile).getByRole('button', { name: 'Plus d’actions' }));
  return { invoke, user };
};

describe('App, the menu of a tile', () => {
  it('sends the promotion once confirmed', async () => {
    const { invoke, user } = await launch();
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect(invoke).toHaveBeenCalledWith('orchestrator:promote', { agentId: agent(1).id });
  });

  it('sends the new name', async () => {
    const { invoke, user } = await launch();
    await user.click(screen.getByRole('menuitem', { name: 'Renommer' }));
    const field = screen.getByRole('textbox', { name: 'Nom de l’agent' });
    await user.clear(field);
    await user.type(field, 'Alice{Enter}');
    expect(invoke).toHaveBeenCalledWith('agent:rename', { agentId: agent(1).id, name: 'Alice' });
  });
});
