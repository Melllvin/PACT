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
});
