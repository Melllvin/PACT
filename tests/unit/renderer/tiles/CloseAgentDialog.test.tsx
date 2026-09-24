import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CloseAgentDialog } from '../../../../src/renderer/tiles/CloseAgentDialog';

// T078 — closing an agent asks what becomes of its worktree and branch (FR-037).

const setup = () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloseAgentDialog
      name="Claude Code 1"
      branch="feature/login"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
};

describe('CloseAgentDialog', () => {
  it('keeps the worktree and branch by default', async () => {
    const { onConfirm } = setup();
    expect(screen.getByRole('dialog', { name: 'Fermer Claude Code 1' })).toBeDefined();
    expect(screen.getByRole('radio', { name: /Conserver/ })).toHaveProperty('checked', true);
    await userEvent.click(screen.getByRole('button', { name: 'Fermer l’agent' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('removes them when asked, naming the branch that goes', async () => {
    const { onConfirm } = setup();
    const remove = screen.getByRole('radio', { name: /Supprimer/ });
    expect(remove.closest('label')?.textContent).toContain('feature/login');
    await userEvent.click(remove);
    await userEvent.click(screen.getByRole('button', { name: 'Fermer l’agent' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('confirms with Enter and cancels with Escape or « Annuler »', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledWith(false);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
