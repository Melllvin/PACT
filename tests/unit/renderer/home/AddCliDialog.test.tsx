import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AddCliDialog } from '../../../../src/renderer/home/AddCliDialog';

// T102 — « Autre CLI — ajouter » (FR-008, US6 scenario 6).

const setup = (error: string | null = null) => {
  const user = userEvent.setup();
  const onAdd = vi.fn();
  const onCancel = vi.fn();
  render(<AddCliDialog error={error} onAdd={onAdd} onCancel={onCancel} />);
  return { user, onAdd, onCancel };
};

const button = (name: string) => screen.getByRole('button', { name });

describe('AddCliDialog', () => {
  it('asks for a name and the command that starts the CLI', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Ajouter un CLI' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Nom' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Commande' })).toHaveProperty(
      'placeholder',
      'aider --no-git',
    );
  });

  it('adds only once both are given, without surrounding spaces', async () => {
    const { user, onAdd } = setup();
    expect(button('Ajouter').hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Nom' }), ' Aider ');
    expect(button('Ajouter').hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Commande' }), ' aider ');
    await user.click(button('Ajouter'));
    expect(onAdd).toHaveBeenCalledWith('Aider', 'aider');
  });

  it('cancels with its button or Escape', async () => {
    const { user, onCancel } = setup();
    await user.click(button('Annuler'));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('shows why the CLI was refused', () => {
    setup('Nom requis.');
    expect(screen.getByRole('alert').textContent).toBe('Nom requis.');
  });
});
