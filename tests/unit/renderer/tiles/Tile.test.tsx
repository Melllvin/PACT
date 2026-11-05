import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tile } from '../../../../src/renderer/tiles/Tile';
import type { Agent } from '../../../../src/shared/model';
import { agent, rateLimited, scheduledResume, time } from './fixtures';

// T070 — the agent tile (FR-020…FR-024, US3 scenarios 3 to 6, screens 1f and 1n).

const setup = (
  overrides: Partial<Agent> = {},
  extra: {
    onExpand?: () => void;
    fromOrchestrator?: boolean;
    round?: number | null;
    reports?: { kind: string; summary: string }[];
  } = {},
) => {
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
    expect(
      within(tools)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Branche et port', 'Agrandir', 'Fermer l’agent']);
  });

  it('comes in after the tiles before it when the view changes, unless motion is reduced (FR-042)', () => {
    const { tile } = setup({ position: 3 });
    expect(tile().className).toMatch(/animate-tile-enter/);
    expect(tile().className).toMatch(/motion-reduce:animate-none/);
    expect(tile().style.getPropertyValue('--enter-index')).toBe('2');
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
    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
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

describe('Tile and the orchestrator (003 T019)', () => {
  it('marks the orchestrator', () => {
    const { tile } = setup({ role: 'orchestrator' });
    expect(within(tile()).getByText('◎ Orchestrateur')).toBeDefined();
  });

  it('marks an agent working on a prompt of the orchestrator', () => {
    const { tile } = setup({ state: 'working' }, { fromOrchestrator: true });
    expect(within(tile()).getByText('◎ de l’orchestrateur')).toBeDefined();
  });

  it('marks neither for an ordinary agent', () => {
    const { tile } = setup();
    expect(within(tile()).queryByText(/◎/)).toBeNull();
  });
});

describe('Tile and the roles (004 T011, FR-006)', () => {
  it.each([
    ['spec', 'Spec'],
    ['design', 'Design'],
    ['dev', 'Dev'],
    ['test', 'Test'],
    ['recap', 'Recap'],
  ] as const)('shows the role %s', (role, label) => {
    const { tile } = setup({ role });
    expect(within(tile()).getByLabelText('Rôle').textContent).toBe(label);
  });

  it('shows no role for an ordinary agent', () => {
    const { tile } = setup();
    expect(within(tile()).queryByLabelText('Rôle')).toBeNull();
  });
});

describe('Tile and the loops (004 T022)', () => {
  it('shows the round of the loop the agent works in', () => {
    const { tile } = setup({ role: 'dev' }, { round: 2 });
    expect(within(tile()).getByLabelText('Tour').textContent).toBe('tour 2/3');
  });

  it('shows no round outside a loop', () => {
    const { tile } = setup({ role: 'dev' });
    expect(within(tile()).queryByLabelText('Tour')).toBeNull();
  });

  it('shows the latest three reports on the orchestrator, their first line only', () => {
    const reports = ['un', 'deux', 'trois', 'quatre\nFAIL a.test.ts'].map((summary) => ({
      kind: 'report',
      summary,
    }));
    const { tile } = setup({ role: 'orchestrator' }, { reports });
    const band = within(tile()).getByRole('list', { name: 'Rapports' });
    expect(
      within(band)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['deux', 'trois', 'quatre']);
  });

  it('shows no band on another agent, nor without a report', () => {
    expect(
      within(
        setup({ role: 'dev' }, { reports: [{ kind: 'report', summary: 'un' }] }).tile(),
      ).queryByRole('list', { name: 'Rapports' }),
    ).toBeNull();
  });
});

// 006 Phase 4 — T022a. xterm's fit counts the padding of the element it is opened in as free height
// (FR-021): the terminal opens in a div without any padding, and the buttons of the state no
// longer take room at the bottom (FR-022).
describe('Tile terminal and action buttons (006 T022a, FR-021, FR-022)', () => {
  const PADDING = /(?:^|\s)-?p[xytblrse]?-/;
  const body = () => screen.getByLabelText(/^Terminal de /);

  it('opens the terminal in a container without padding, so that the fit offers the free area', () => {
    const { terminals } = setup({ state: 'working' });
    const attached = (
      terminals.attach.mock.calls as unknown as [string, HTMLElement][]
    )[0]?.[1] as HTMLElement;
    expect(attached).toBeInstanceOf(HTMLElement);
    expect(attached.className).not.toMatch(PADDING);
    expect(attached.getAttribute('style') ?? '').not.toMatch(/padding/);
    // The margin of the tile is on a parent, never on the element xterm measures.
    expect(body().contains(attached)).toBe(true);
    expect(screen.getByRole('article').contains(attached)).toBe(true);
  });

  it.each(['awaiting-answer', 'error'] as const)(
    'reserves no room under the terminal while the agent is %s',
    (state) => {
      setup({ state });
      expect(body().className).not.toMatch(/pb-14/);
      expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    },
  );

  it('gives the terminal the same room whatever the state', () => {
    const { rerender } = setup({ state: 'working' });
    const before = body().className;
    rerender({ state: 'awaiting-answer' });
    expect(body().className).toBe(before);
  });

  it('shows the action buttons on hover or focus within the tile only', () => {
    setup({ state: 'awaiting-answer' });
    const tile = screen.getByRole('article');
    expect(tile.className).toMatch(/(?:^|\s)group(?:\/\S+)?(?:\s|$)/);
    // One of the ancestors of the buttons, inside the tile, is hidden until then.
    const allow = screen.getByRole('button', { name: '✓ Autoriser' });
    let hidden: HTMLElement | null = null;
    for (let el = allow.parentElement; el && el !== tile; el = el.parentElement) {
      if (/(?:^|\s)opacity-0(?:\s|$)/.test(el.className)) hidden = el;
    }
    expect(hidden).not.toBeNull();
    expect(hidden?.className).toMatch(/group-hover(?:\/\S+)?:opacity-100/);
    expect(hidden?.className).toMatch(/group-focus-within(?:\/\S+)?:opacity-100/);
  });

  it('keeps the buttons reachable by keyboard (still in the tab order)', () => {
    setup({ state: 'awaiting-answer' });
    const allow = screen.getByRole('button', { name: '✓ Autoriser' });
    expect(allow.getAttribute('tabindex')).not.toBe('-1');
    expect(allow.closest('[hidden], [aria-hidden="true"], [inert]')).toBeNull();
  });

  it('signals an action that is due on the outline of the tile, without hover', () => {
    const { tile, rerender } = setup({ state: 'working' });
    const quiet = tile().className;
    rerender({ state: 'awaiting-answer' });
    expect(tile().className).not.toBe(quiet);
    expect(tile().className).toMatch(/(?:ring|outline|border|shadow)/);
  });
});
