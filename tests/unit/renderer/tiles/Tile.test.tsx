import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tile } from '../../../../src/renderer/tiles/Tile';
import type { Agent } from '../../../../src/shared/model';
import { agent, rateLimited, scheduledResume, time } from './fixtures';

// T070 — the agent tile (FR-020…FR-024, US3 scenarios 3 to 6, screens 1f and 1n).

const setup = (overrides: Partial<Agent> = {}, extra: { onExpand?: () => void } = {}) => {
  const actions = {
    onAnswer: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLog: vi.fn(),
    onCancelAutoResume: vi.fn(),
    onClose: vi.fn(),
  };
  const terminals = { attach: vi.fn(() => () => undefined) };
  const view = (a: Agent) => (
    <Tile agent={a} name="Claude Code" terminals={terminals} {...actions} {...extra} />
  );
  const { rerender } = render(view(agent(1, overrides)));
  const tile = () => screen.getByRole('article');
  return {
    actions,
    terminals,
    tile,
    rerender: (next: Partial<Agent>) => {
      rerender(view(agent(1, { ...overrides, ...next })));
    },
  };
};

describe('Tile', () => {
  it('borders the tile with the agent color and shows its terminal', () => {
    const { tile, terminals } = setup({ color: 'magenta' });
    expect(tile().style.getPropertyValue('--agent-color')).toBe('var(--agent-magenta)');
    expect(terminals.attach).toHaveBeenCalledWith(agent(1).id, expect.any(HTMLElement));
  });

  it('groups ⎇, ⤢ and the close button as the tools of the tile (1f)', () => {
    const { tile } = setup({}, { onExpand: vi.fn() });
    const tools = within(tile()).getByRole('toolbar', { name: 'Outils' });
    expect(within(tools).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Branche et port',
      'Agrandir',
      'Fermer l’agent',
    ]);
  });

  it('shows neither number, title nor state label (FR-020)', () => {
    const { tile } = setup({ state: 'working' });
    expect(tile().textContent).not.toMatch(/Claude Code|1|en cours|▶/);
    expect(tile().getAttribute('aria-label')).toBe('Claude Code 1, en cours');
  });

  it('shows the current branch and the port when ⎇ is hovered or focused (FR-021)', async () => {
    const user = userEvent.setup();
    const { rerender } = setup();
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.hover(screen.getByRole('button', { name: 'Branche et port' }));
    expect(screen.getByRole('tooltip').textContent).toBe('agent/claude-code-1 · :3001');
    rerender({ branch: 'feature/login' });
    expect(screen.getByRole('tooltip').textContent).toBe('feature/login · :3001');
    await user.unhover(screen.getByRole('button', { name: 'Branche et port' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      screen.getByRole('button', { name: 'Branche et port' }).focus();
    });
    expect(screen.getByRole('tooltip')).toBeDefined();
    act(() => {
      screen.getByRole('button', { name: 'Branche et port' }).blur();
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('pulses the border once for each change of state (FR-023)', () => {
    const { tile, rerender } = setup();
    expect(tile().dataset.pulse).toBe('0');
    rerender({ state: 'working' });
    expect(tile().dataset.pulse).toBe('1');
    rerender({ state: 'working', branch: 'feature/login' });
    expect(tile().dataset.pulse).toBe('1');
    rerender({ state: 'done' });
    expect(tile().dataset.pulse).toBe('2');
  });

  it('keeps a red halo while the agent is in error', () => {
    const { tile, rerender } = setup({
      state: 'error',
      lastError: { code: 1, kind: 'crash', message: 'Le processus s’est arrêté (code 1).' },
    });
    expect(tile().dataset.state).toBe('error');
    expect(tile().className).toMatch(/halo/);
    expect(tile().textContent).toContain('Le processus s’est arrêté (code 1).');
    rerender({ state: 'starting', lastError: null });
    expect(tile().className).not.toMatch(/halo/);
  });

  it('offers « Autoriser » and « Refuser » while the agent waits for an answer', async () => {
    const user = userEvent.setup();
    const { actions } = setup({ state: 'awaiting-answer' });
    await user.click(screen.getByRole('button', { name: '✓ Autoriser' }));
    await user.click(screen.getByRole('button', { name: '✕ Refuser' }));
    expect(actions.onAnswer.mock.calls).toEqual([['allow'], ['deny']]);
    expect(screen.queryByRole('button', { name: 'Reprendre' })).toBeNull();
  });

  it('offers « Journal », « Relancer » and « Reprendre » after an error (FR-024)', async () => {
    const user = userEvent.setup();
    const { actions } = setup({ state: 'error' });
    await user.click(screen.getByRole('button', { name: 'Journal' }));
    await user.click(screen.getByRole('button', { name: 'Relancer' }));
    await user.click(screen.getByRole('button', { name: 'Reprendre' }));
    expect(actions.onLog).toHaveBeenCalledOnce();
    expect(actions.onRestart).toHaveBeenCalledOnce();
    expect(actions.onResume).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '✓ Autoriser' })).toBeNull();
  });

  it('shows the scheduled resume with « Annuler » after a rate limit (FR-036)', async () => {
    const user = userEvent.setup();
    const { actions } = setup({ ...rateLimited, scheduledResume });
    expect(screen.getByText(`reprise auto à ${time}`)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(actions.onCancelAutoResume).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeDefined();
  });

  it('shows no scheduled resume when there is none', () => {
    setup(rateLimited);
    expect(screen.queryByText(/reprise auto/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Annuler' })).toBeNull();
  });

  it.each(['starting', 'awaiting-prompt', 'working', 'done'] as const)(
    'offers no state action while %s',
    (state) => {
      setup({ state });
      for (const name of ['✓ Autoriser', '✕ Refuser', 'Journal', 'Relancer', 'Reprendre']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
    },
  );

  it('closes the agent from its tile', async () => {
    const user = userEvent.setup();
    const { actions } = setup();
    await user.click(screen.getByRole('button', { name: 'Fermer l’agent' }));
    expect(actions.onClose).toHaveBeenCalledOnce();
  });

  it('offers ⤢ only when an enlarged view is available', async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    setup({}, { onExpand });
    await user.click(screen.getByRole('button', { name: 'Agrandir' }));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('shows no ⤢ without an enlarged view', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Agrandir' })).toBeNull();
  });

  it('shows the tile without its terminal when no registry is given', () => {
    render(
      <Tile
        agent={agent(1)}
        name="Claude Code"
        terminals={undefined}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/Terminal de/)).toBeNull();
  });
});
