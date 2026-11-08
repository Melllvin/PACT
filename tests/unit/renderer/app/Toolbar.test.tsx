import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../../../../src/renderer/app/Toolbar';

// 002 T051 — the Revue view of the toolbar, with the number of agents to review (FR-003).

describe('Toolbar, Revue view', () => {
  it('stays inactive and without a badge when nothing is to review (US5 scenario 1)', () => {
    render(<Toolbar todoCount={0} reviewCount={0} onView={vi.fn()} />);
    const revue = screen.getByRole('radio', { name: 'Revue' });
    expect(revue.hasAttribute('disabled')).toBe(true);
    expect(within(revue).queryByText('0')).toBeNull();
  });

  it('counts the agents to review, and opens the view', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} reviewCount={2} onView={onView} />);
    const revue = screen.getByRole('radio', { name: /Revue/ });
    expect(revue.hasAttribute('disabled')).toBe(false);
    expect(within(revue).getByText('2').dataset.slot).toBe('badge');
    await userEvent.click(revue);
    expect(onView).toHaveBeenCalledWith('review');
  });

  it('shows the view in use, and goes back to the tiles', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} reviewCount={1} view="review" onView={onView} />);
    expect(screen.getByRole('radio', { name: /Revue/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: 'Tuiles' }));
    expect(onView).toHaveBeenCalledWith('tiles');
  });

  it('stays on the view in use when it is pressed again', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} reviewCount={1} view="tiles" onView={onView} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Tuiles' }));
    expect(onView).not.toHaveBeenCalled();
  });
});

// 006 T013 — the toggle of the right column is « Agents <M> » (M = items to handle), no longer
// « À faire ».
describe('Toolbar, Agents column toggle', () => {
  it('is named « Agents <M> »', () => {
    render(<Toolbar todoCount={3} onView={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Agents 3' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /À faire/ })).toBeNull();
  });

  it('keeps the count at zero', () => {
    render(<Toolbar todoCount={0} onView={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Agents 0' })).toBeDefined();
  });

  it('is pressed when the column is open, and toggles it', async () => {
    const onToggleTodo = vi.fn();
    render(<Toolbar todoCount={1} todoOpen onToggleTodo={onToggleTodo} onView={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Agents 1' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(toggle);
    expect(onToggleTodo).toHaveBeenCalledTimes(1);
  });
});

// 006 T025 — the Graphe view of the toolbar (contracts/ui.md « Barre Vues », FR-012): a radio of
// the radiogroup « Vue », active as soon as an agent exists (`showTodo`, which is off until then).
describe('Toolbar, Graphe view', () => {
  it('has a radio « Graphe » in the radiogroup « Vue »', () => {
    render(<Toolbar todoCount={0} onView={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'Vue' });
    expect(within(group).getByRole('radio', { name: 'Graphe' })).toBeDefined();
  });

  it('is active as soon as an agent exists, and opens the view', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} showTodo onView={onView} />);
    const graphe = screen.getByRole('radio', { name: 'Graphe' });
    expect(graphe.hasAttribute('disabled')).toBe(false);
    await userEvent.click(graphe);
    expect(onView).toHaveBeenCalledWith('graph');
  });

  it('is inactive while there is no agent', () => {
    render(<Toolbar todoCount={0} showTodo={false} onView={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Graphe' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows the view in use, and goes back to the tiles', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} view="graph" onView={onView} />);
    expect(screen.getByRole('radio', { name: 'Graphe' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: 'Tuiles' }));
    expect(onView).toHaveBeenCalledWith('tiles');
  });

  it('stays on the graph when it is pressed again', async () => {
    const onView = vi.fn();
    render(<Toolbar todoCount={0} view="graph" onView={onView} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Graphe' }));
    expect(onView).not.toHaveBeenCalled();
  });
});
