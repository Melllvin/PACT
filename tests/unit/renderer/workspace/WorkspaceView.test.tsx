import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceView,
  type ReviewBinding,
} from '../../../../src/renderer/workspace/WorkspaceView';
import type { Agent, CliDefinition, Workspace } from '../../../../src/shared/model';
import { diff, snapshot } from '../review/fixtures';
import { rateLimited, scheduledResume } from '../tiles/fixtures';

// T068, T069, T079 — the tiles of the agents and free terminals, in the grid.

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
  review: { seen: {}, comments: [] },
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
  testCommand: null,
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

const colors = ['purple', 'cyan', 'green', 'magenta', 'yellow', 'slate'] as const;
const agents = (count: number) =>
  Array.from({ length: count }, (_, i) => agent(i + 1, { color: colors[i] ?? 'slate' }));
const borders = () =>
  screen
    .getAllByRole('article')
    .map((tile) => tile.style.getPropertyValue('--agent-color'))
    .filter(Boolean);

describe('WorkspaceView', () => {
  it('shows one tile per agent in position order, with its terminal', () => {
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
      'Claude Code 1, erreur',
      'Claude Code 2, en cours',
    ]);
    expect(terminals.attach).toHaveBeenCalledTimes(2);
  });

  it('names a tile after its CLI id when the CLI is no longer known', () => {
    render(<WorkspaceView workspace={workspace({ agents: [agent(1, { cliId: 'aider' })] })} />);
    expect(screen.getByRole('article', { name: 'aider 1, attend une consigne' })).toBeDefined();
  });

  it('goes from 2×2 to 3×2 with the fifth agent, without changing any color (T069)', () => {
    const { rerender } = render(
      <WorkspaceView workspace={workspace({ agents: agents(4) })} clis={clis} />,
    );
    expect(screen.getByRole('region', { name: 'Tuiles' }).dataset.layout).toBe('2x2');
    const before = borders();
    rerender(<WorkspaceView workspace={workspace({ agents: agents(5) })} clis={clis} />);
    expect(screen.getByRole('region', { name: 'Tuiles' }).dataset.layout).toBe('3x2');
    expect(borders().slice(0, 4)).toEqual(before);
  });

  it('offers « + » in the free slots while agents can be added', async () => {
    const user = userEvent.setup();
    const onAddAgents = vi.fn();
    const { rerender } = render(
      <WorkspaceView
        workspace={workspace({ agents: agents(3) })}
        clis={clis}
        onAddAgents={onAddAgents}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Ajouter un agent' }));
    expect(onAddAgents).toHaveBeenCalledOnce();
    rerender(
      <WorkspaceView
        workspace={workspace({ agents: agents(6), freeTerminals: [] })}
        clis={clis}
        onAddAgents={onAddAgents}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Ajouter un agent' })).toBeNull();
  });

  it('adds a tile per free terminal, open at the root of the repository (T079)', () => {
    const terminals = registry();
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
        terminals={terminals}
      />,
    );
    const tile = screen.getByRole('article', { name: 'Terminal libre' });
    expect(within(tile).getByText('/w')).toBeDefined();
    expect(within(tile).getByLabelText('Shell dans /w')).toBeDefined();
    expect(terminals.attach).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000009',
      expect.any(HTMLElement),
    );
  });

  it('passes the tile actions on with the agent they are about', async () => {
    const user = userEvent.setup();
    const actions = {
      onAnswer: vi.fn(),
      onResume: vi.fn(),
      onRestart: vi.fn(),
      onLog: vi.fn(),
      onCancelAutoResume: vi.fn(),
      onClose: vi.fn(),
    };
    const waiting = agent(1, { state: 'awaiting-answer' });
    const failed = agent(2, {
      ...rateLimited,
      scheduledResume: { ...scheduledResume, agentId: agent(2).id },
    });
    render(
      <WorkspaceView
        workspace={workspace({ agents: [waiting, failed] })}
        clis={clis}
        actions={actions}
      />,
    );
    const tiles = within(screen.getByRole('region', { name: 'Tuiles' }));
    await user.click(tiles.getByRole('button', { name: '✓ Autoriser' }));
    await user.click(tiles.getByRole('button', { name: 'Journal' }));
    await user.click(tiles.getByRole('button', { name: 'Relancer' }));
    await user.click(tiles.getByRole('button', { name: 'Reprendre' }));
    await user.click(tiles.getByRole('button', { name: 'Annuler' }));
    await user.click(screen.getAllByRole('button', { name: 'Fermer l’agent' })[0] ?? document.body);
    expect(actions.onAnswer).toHaveBeenCalledWith(waiting.id, 'allow');
    expect(actions.onLog).toHaveBeenCalledWith(failed.id);
    expect(actions.onRestart).toHaveBeenCalledWith(failed.id);
    expect(actions.onResume).toHaveBeenCalledWith(failed.id);
    expect(actions.onCancelAutoResume).toHaveBeenCalledWith(failed.id);
    expect(actions.onClose).toHaveBeenCalledWith(waiting.id);
  });

  it('shows a refused action', () => {
    render(
      <WorkspaceView
        workspace={workspace({ agents: [agent(1)] })}
        clis={clis}
        actionError="Cet agent n’attend pas de réponse."
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Cet agent n’attend pas de réponse.');
  });

  it('does nothing on a tile action when no handler is given', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceView
        workspace={workspace({ agents: [agent(1, { state: 'error' })] })}
        clis={clis}
        terminals={registry()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Relancer' }));
    expect(screen.getByRole('region', { name: 'Tuiles' })).toBeDefined();
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

describe('À faire column (T082, T086)', () => {
  const waiting = [agent(1, { state: 'awaiting-prompt' }), agent(2, { state: 'awaiting-answer' })];

  it('lists what the agents need, answers first, with the count on the button', () => {
    render(<WorkspaceView workspace={workspace({ agents: waiting })} clis={clis} />);
    const column = screen.getByRole('complementary', { name: 'À faire' });
    expect(
      within(column)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('◆ Répondre'),
      'Donner une consigne · Claude Code · tapez dans le terminal',
    ]);
    expect(screen.getByRole('button', { name: /À faire/ }).textContent).toContain('2');
  });

  it('answers from the column for the agent of the item', async () => {
    const onAnswer = vi.fn();
    render(
      <WorkspaceView
        workspace={workspace({ agents: waiting })}
        clis={clis}
        actions={{
          onAnswer,
          onResume: vi.fn(),
          onRestart: vi.fn(),
          onLog: vi.fn(),
          onCancelAutoResume: vi.fn(),
          onClose: vi.fn(),
        }}
      />,
    );
    const column = screen.getByRole('complementary', { name: 'À faire' });
    await userEvent.click(within(column).getByRole('button', { name: '✓ Autoriser' }));
    expect(onAnswer).toHaveBeenCalledWith(agent(2).id, 'allow');
  });

  it('closes into the button, which keeps the count', async () => {
    render(<WorkspaceView workspace={workspace({ agents: waiting })} clis={clis} />);
    await userEvent.click(screen.getByRole('button', { name: /À faire/ }));
    expect(screen.queryByRole('complementary', { name: 'À faire' })).toBeNull();
    expect(screen.getByRole('button', { name: /À faire/ }).textContent).toContain('2');
    await userEvent.click(screen.getByRole('button', { name: /À faire/ }));
    expect(screen.getByRole('complementary', { name: 'À faire' })).toBeDefined();
  });

  it('counts only what waits on the button, not a running free terminal (FR-029)', () => {
    render(
      <WorkspaceView
        workspace={workspace({
          agents: waiting,
          freeTerminals: [{ id: 't1', workspaceId: 'w1', cwd: '/w', shell: '/bin/zsh' }],
        })}
        clis={clis}
      />,
    );
    const column = screen.getByRole('complementary', { name: 'À faire' });
    expect(within(column).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /À faire/ }).textContent).toBe('À faire 2');
  });

  it('is absent without agents, even with a free terminal', () => {
    render(
      <WorkspaceView
        workspace={workspace({
          freeTerminals: [{ id: 't1', workspaceId: 'w1', cwd: '/w', shell: '/bin/zsh' }],
        })}
        clis={clis}
      />,
    );
    expect(screen.queryByRole('complementary', { name: 'À faire' })).toBeNull();
    expect(screen.queryByRole('button', { name: /À faire/ })).toBeNull();
  });
});

describe('Focus (T087, US5)', () => {
  it('opens the Focus with ⤢ and comes back to the grid, terminals kept (US5)', async () => {
    const user = userEvent.setup();
    const terminals = registry();
    render(
      <WorkspaceView
        workspace={workspace({ agents: agents(2) })}
        clis={clis}
        terminals={terminals}
      />,
    );
    const second = screen.getAllByRole('button', { name: 'Agrandir' })[1] ?? document.body;
    await user.click(second);
    expect(screen.queryByRole('region', { name: 'Tuiles' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Focus : Claude Code 2' })).toBeDefined();
    await user.click(screen.getByRole('radio', { name: 'Claude Code 1' }));
    expect(screen.getByRole('region', { name: 'Focus : Claude Code 1' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: '‹ Tuiles' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(terminals.attach).toHaveBeenLastCalledWith(agent(2).id, expect.any(HTMLElement));
  });

  it('goes back to the grid when the agent in Focus is closed', async () => {
    const user = userEvent.setup();
    const view = (count: number) => (
      <WorkspaceView workspace={workspace({ agents: agents(count) })} clis={clis} />
    );
    const { rerender } = render(view(2));
    await user.click(screen.getAllByRole('button', { name: 'Agrandir' })[1] ?? document.body);
    rerender(view(1));
    expect(screen.getByRole('region', { name: 'Tuiles' })).toBeDefined();
  });
});

describe('Review (002 T018, US1)', () => {
  const files = snapshot().files;
  const binding = (overrides: Partial<ReviewBinding> = {}): ReviewBinding => ({
    pending: [agent(2).id],
    snapshot: snapshot({ agentId: agent(2).id }),
    selected: 'src/db.ts',
    diff: diff('src/db.ts'),
    error: null,
    open: vi.fn(),
    close: vi.fn(),
    select: vi.fn(),
    markSeen: vi.fn(),
    ...overrides,
  });
  const view = (review: ReviewBinding, team = agents(2)) => (
    <WorkspaceView
      workspace={workspace({ agents: team })}
      clis={clis}
      terminals={registry()}
      review={review}
    />
  );
  const tile = (n: number) =>
    screen
      .getAllByRole('article')
      .find((a) => a.getAttribute('aria-label')?.startsWith(`Claude Code ${String(n)},`)) ??
    document.body;

  it('offers « Revue → » on the tile of an agent to review only (FR-002)', () => {
    render(view(binding()));
    expect(within(tile(2)).getByRole('button', { name: 'Revue →' })).toBeDefined();
    expect(within(tile(1)).queryByRole('button', { name: 'Revue →' })).toBeNull();
  });

  it('opens the Changements tab with the Décision column, then goes back to À faire', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(view(review));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    expect(screen.getByRole('region', { name: 'Focus : Claude Code 2' })).toBeDefined();
    expect(screen.getByRole('tab', { name: 'Changements' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(review.open).toHaveBeenCalledWith(agent(2).id);
    expect(screen.getByRole('complementary', { name: 'Décision' })).toBeDefined();
    expect(screen.queryByRole('complementary', { name: 'À faire' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Changements · 3' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: '‹ Tuiles' }));
    expect(review.close).toHaveBeenCalled();
    expect(screen.getByRole('complementary', { name: 'À faire' })).toBeDefined();
    expect(screen.queryByRole('complementary', { name: 'Décision' })).toBeNull();
  });

  it('opens the review from the À faire column too', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(view(review));
    const column = screen.getByRole('complementary', { name: 'À faire' });
    await user.click(within(column).getByRole('button', { name: 'Revue →' }));
    expect(review.open).toHaveBeenCalledWith(agent(2).id);
  });

  it('counts the files left to see in the Décision column', async () => {
    const user = userEvent.setup();
    const team = agents(2);
    team[1] = {
      ...(team[1] ?? agent(2)),
      review: { seen: { 'src/auth.ts': files[0]?.blob ?? '' }, comments: [] },
    };
    render(view(binding(), team));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    const column = screen.getByRole('complementary', { name: 'Décision' });
    expect(column.textContent).toContain('2 fichiers non vus');
  });

  it('marks a file seen with the content shown, for the agent reviewed', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(view(review));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    await user.click(screen.getByRole('checkbox', { name: 'Vu : src/db.ts' }));
    expect(review.markSeen).toHaveBeenCalledWith(agent(2).id, 'src/db.ts', files[1]?.blob);
  });

  it('follows the agent picked from the pills, and leaves the Terminal tab without closing the Focus', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(view(review));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    await user.click(screen.getByRole('radio', { name: 'Claude Code 1' }));
    expect(review.open).toHaveBeenLastCalledWith(agent(1).id);
    await user.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(review.close).toHaveBeenCalled();
    expect(screen.getByRole('complementary', { name: 'À faire' })).toBeDefined();
  });

  it('selects a file of the list for its diff', async () => {
    const user = userEvent.setup();
    const review = binding();
    render(view(review));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    const list = screen.getByRole('list', { name: 'Fichiers' });
    await user.click(within(list).getByRole('button', { name: /src\/auth\.ts/ }));
    expect(review.select).toHaveBeenCalledWith('src/auth.ts');
  });

  it('waits for the snapshot of the agent reviewed, not showing another one', async () => {
    const user = userEvent.setup();
    render(view(binding({ snapshot: snapshot({ agentId: agent(1).id }) })));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    expect(screen.getByText('Chargement des changements…')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('unmarks a seen file, with no file selected yet', async () => {
    const user = userEvent.setup();
    const team = agents(2);
    team[1] = {
      ...(team[1] ?? agent(2)),
      review: { seen: { 'src/auth.ts': files[0]?.blob ?? '' }, comments: [] },
    };
    const review = binding({ selected: null, diff: null });
    render(view(review, team));
    await user.click(within(tile(2)).getByRole('button', { name: 'Revue →' }));
    await user.click(screen.getByRole('checkbox', { name: 'Vu : src/auth.ts' }));
    expect(review.markSeen).toHaveBeenCalledWith(agent(2).id, 'src/auth.ts', null);
  });
});
