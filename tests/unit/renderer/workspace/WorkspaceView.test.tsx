import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView } from '../../../../src/renderer/workspace/WorkspaceView';
import type { Agent, CliDefinition, Workspace } from '../../../../src/shared/model';

// T068 — until US3, each agent and free terminal gets a minimal tile around its terminal.

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  workspaceId: 'w1',
  position: n,
  color: n === 1 ? 'purple' : 'cyan',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(n)}`,
  worktreePath: `/w/.worktrees/claude-code-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'awaiting-prompt',
  lastError: null,
  scheduledResume: null,
  ...overrides,
});

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  path: '/w',
  name: 'w',
  mainBranch: 'main',
  agents: [],
  freeTerminals: [],
  quickLaunchCounters: { freeTerminal: 0 },
  permissionOverride: null,
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
  ...overrides,
});

const clis: CliDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    adapter: 'claude-code',
    command: 'claude',
    resolvedPath: '/bin/claude',
    version: '2.1.281',
    origin: 'detected',
    status: 'installed',
    models: [],
  },
];

const registry = () => ({ attach: vi.fn(() => () => undefined) });

describe('WorkspaceView', () => {
  it('shows one tile per agent with its branch, port and state, in position order', () => {
    const terminals = registry();
    render(
      <WorkspaceView
        workspace={workspace({
          agents: [agent(2, { state: 'working' }), agent(1, { state: 'error' })],
        })}
        clis={clis}
        terminals={terminals}
      />,
    );
    const tiles = screen.getAllByRole('article');
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Claude Code 1',
      'Claude Code 2',
    ]);
    expect(tiles[0]?.textContent).toMatch(/agent\/claude-code-1.*:3001.*✕/);
    expect(tiles[1]?.textContent).toMatch(/▶/);
    expect(terminals.attach).toHaveBeenCalledTimes(2);
  });

  it('adds a tile per free terminal', () => {
    render(
      <WorkspaceView
        workspace={workspace({
          freeTerminals: [
            {
              id: '00000000-0000-4000-8000-000000000009',
              workspaceId: 'w1',
              cwd: '/w',
              shell: '/bin/zsh',
            },
          ],
        })}
        clis={clis}
        terminals={registry()}
      />,
    );
    expect(
      within(screen.getByRole('article', { name: 'Terminal libre' })).getByText('/w'),
    ).toBeDefined();
  });

  it('opens the launcher from « + Agents » once agents exist', async () => {
    const user = userEvent.setup();
    const onAddAgents = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace({ agents: [agent(1)] })}
        clis={clis}
        terminals={registry()}
        onAddAgents={onAddAgents}
      />,
    );
    await user.click(screen.getByRole('button', { name: '+ Agents' }));
    expect(onAddAgents).toHaveBeenCalled();
  });
});
