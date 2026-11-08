import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceView, type AgentActions } from '../../../../src/renderer/workspace/WorkspaceView';
import {
  DEFAULT_TEST_PATHS,
  type Agent,
  type CliDefinition,
  type Workspace,
} from '../../../../src/shared/model';

// 006 phase 7 — the ⋮ menu of a tile, as the workspace builds it: reasons to refuse, and the
// callbacks of « Faire orchestrateur » and « Renommer » (US5, #45).

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  workspaceId: 'w1',
  position: n,
  color: 'purple',
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
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
  name: null,
  pause: null,
  ...overrides,
});

const workspace = (agents: Agent[]): Workspace => ({
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
  roleProfiles: {},
  issues: [],
  loops: [],
  testPaths: [...DEFAULT_TEST_PATHS],
  publishRequests: [],
  exchanges: { messages: [], escalations: [] },
  lastOpenedAt: '2026-09-24T10:00:00.000Z',
  status: 'available',
});

const cli = (id: string, orchestrator: boolean): CliDefinition => ({
  id,
  name: id === 'claude-code' ? 'Claude Code' : 'Aider',
  adapter: 'claude-code',
  command: id,
  resolvedPath: `/bin/${id}`,
  version: '1',
  origin: 'detected',
  status: 'installed',
  modelTiers: [],
  models: [],
  orchestrator,
});

const handlers = (extra: Partial<AgentActions>): AgentActions => ({
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
  onClose: vi.fn(),
  ...extra,
});

const menuOf = async (tile: string) => {
  const user = userEvent.setup();
  const article = screen.getByRole('article', { name: new RegExp(tile) });
  await user.click(within(article).getByRole('button', { name: 'Plus d’actions' }));
  return user;
};

describe('WorkspaceView menu', () => {
  it('promotes the agent once the dialog is confirmed', async () => {
    const onPromote = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace([agent(1)])}
        clis={[cli('claude-code', true)]}
        actions={handlers({ onPromote })}
      />,
    );
    const user = await menuOf('Claude Code 1');
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect(onPromote).toHaveBeenCalledWith(agent(1).id);
  });

  it('closes the confirmation with Escape', async () => {
    const onPromote = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace([agent(1)])}
        clis={[cli('claude-code', true)]}
        actions={handlers({ onPromote })}
      />,
    );
    const user = await menuOf('Claude Code 1');
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Faire orchestrateur ?' })).toBeNull();
    expect(onPromote).not.toHaveBeenCalled();
  });

  it('refuses a CLI that cannot be orchestrator, and a closed agent', async () => {
    render(
      <WorkspaceView
        workspace={workspace([agent(1, { cliId: 'aider' }), agent(2, { state: 'closed' })])}
        clis={[cli('aider', false), cli('claude-code', true)]}
        actions={handlers({ onPromote: vi.fn() })}
      />,
    );
    const user = await menuOf('Aider 1');
    expect(
      screen.getByRole('menuitem', { name: /Ce CLI ne sait pas être orchestrateur/ }),
    ).toBeDefined();
    await user.keyboard('{Escape}');
    await menuOf('Claude Code 2');
    expect(screen.getByRole('menuitem', { name: /L’agent est fermé/ })).toBeDefined();
  });

  it('names the orchestrator in the refusal, and offers no promotion to the orchestrator itself', async () => {
    render(
      <WorkspaceView
        workspace={workspace([agent(1, { role: 'orchestrator' }), agent(2)])}
        clis={[cli('claude-code', true)]}
        actions={handlers({ onPromote: vi.fn() })}
      />,
    );
    await menuOf('Claude Code 2');
    expect(
      screen.getByRole('menuitem', { name: /Claude Code 1 est déjà l’orchestrateur/ }),
    ).toBeDefined();
  });

  it('renames the agent', async () => {
    const onRename = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace([agent(1)])}
        clis={[cli('claude-code', true)]}
        actions={handlers({ onRename })}
      />,
    );
    const user = await menuOf('Claude Code 1');
    await user.click(screen.getByRole('menuitem', { name: 'Renommer' }));
    const field = screen.getByRole('textbox', { name: 'Nom de l’agent' });
    await user.clear(field);
    await user.type(field, 'Alice{Enter}');
    expect(onRename).toHaveBeenCalledWith(agent(1).id, 'Alice');
  });
});
