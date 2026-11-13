import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import { DEFAULT_TEST_PATHS, type Workspace } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 T029 — the Graphe view of the workspace: opened from the toolbar, left for the tiles or
// for the Focus of an agent.

const workspace = (agents = [agent(1), agent(2)]): Workspace => ({
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

const graphe = () => screen.queryByRole('region', { name: 'Graphe des agents' });

describe('WorkspaceView, Graphe', () => {
  it('opens the graph, shows it in the toolbar, and goes back to the tiles', async () => {
    render(<WorkspaceView workspace={workspace()} />);
    expect(graphe()).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Graphe' }));
    expect(graphe()).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Graphe' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Tuiles' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Tuiles' }));
    expect(graphe()).toBeNull();
    expect(screen.getByRole('region', { name: 'Tuiles' })).toBeDefined();
  });

  it('opens the Focus of the agent clicked in the graph', async () => {
    render(<WorkspaceView workspace={workspace()} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Graphe' }));
    await userEvent.click(
      within(screen.getByRole('region', { name: 'Graphe des agents' })).getByRole('button', {
        name: /^claude-code 2, /,
      }),
    );
    expect(graphe()).toBeNull();
    expect(screen.getByRole('region', { name: /^Focus : / })).toBeDefined();
  });
});
