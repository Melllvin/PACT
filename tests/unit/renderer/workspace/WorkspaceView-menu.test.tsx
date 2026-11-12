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
  delivery: { auto: false, mergeMode: 'squash', maxRounds: 3, polishPasses: 0, polishBrief: '' },
  deliveries: [],
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

  // #112 — a closed orchestrator directs nothing: it does not stop another agent from becoming one.
  it('offers « Faire orchestrateur » while the orchestrator is closed', async () => {
    render(
      <WorkspaceView
        workspace={workspace([agent(1, { role: 'orchestrator', state: 'closed' }), agent(2)])}
        clis={[cli('claude-code', true)]}
        actions={handlers({ onPromote: vi.fn() })}
      />,
    );
    await menuOf('Claude Code 2');
    expect(
      screen.getByRole('menuitem', { name: 'Faire orchestrateur' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
    expect(screen.queryByText(/est déjà l.orchestrateur/)).toBeNull();
  });

  // #115 — a new agent is never behind the closed tiles kept by 006 FR-023.
  it('puts the live tiles before the closed ones', () => {
    render(
      <WorkspaceView
        workspace={workspace([
          agent(1, { state: 'closed' }),
          agent(2, { state: 'closed' }),
          agent(3),
          agent(4),
        ])}
        clis={[cli('claude-code', true)]}
        actions={handlers({})}
      />,
    );
    const grid = screen.getByRole('region', { name: 'Tuiles' });
    const names = within(grid)
      .getAllByRole('article')
      .map((a) => /Claude Code \d/.exec(a.getAttribute('aria-label') ?? '')?.[0]);
    expect(names).toEqual(['Claude Code 3', 'Claude Code 4', 'Claude Code 1', 'Claude Code 2']);
  });
});
