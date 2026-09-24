import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionsDialog } from '../../../../src/renderer/launch/PermissionsDialog';

// Screen 1m — asked once, on the first launch (FR-012, FR-035, US2 scenario 1).

const renderDialog = () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<PermissionsDialog agentCount={3} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
};

const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });

describe('PermissionsDialog', () => {
  it('offers the three levels, « Toujours autoriser » preselected', () => {
    renderDialog();
    expect((radio('Toujours autoriser') as HTMLInputElement).checked).toBe(true);
    expect((radio('Demander pour les actions sensibles') as HTMLInputElement).checked).toBe(false);
    expect((radio('Toujours demander') as HTMLInputElement).checked).toBe(false);
  });

  it('describes what each level really allows, without promising confinement', () => {
    renderDialog();
    const text = document.body.textContent;
    expect(text).not.toMatch(/agissent seuls dans leur worktree/);
    expect(text).toMatch(/sans vous demander/);
    expect(text).toMatch(/git push/);
    expect(text).toMatch(/attend votre accord/);
  });

  it('offers the « Ce projet » and « Tous les projets » scopes', () => {
    renderDialog();
    expect((radio('Tous les projets') as HTMLInputElement).checked).toBe(true);
    expect((radio('Ce projet') as HTMLInputElement).checked).toBe(false);
  });

  it('resumes automatically after a rate limit by default (FR-035)', () => {
    renderDialog();
    const option = screen.getByRole('checkbox', {
      name: 'Reprendre automatiquement après une limite de débit',
    });
    expect((option as HTMLInputElement).checked).toBe(true);
  });

  it('launches the default choices with Enter', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledWith({
      level: 'always-allow',
      autoResume: true,
      scope: 'global',
    });
  });

  it('launches with the choices made', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(radio('Demander pour les actions sensibles'));
    await user.click(radio('Ce projet'));
    await user.click(
      screen.getByRole('checkbox', { name: 'Reprendre automatiquement après une limite de débit' }),
    );
    await user.click(screen.getByRole('button', { name: 'Lancer 3 agents' }));
    expect(onConfirm).toHaveBeenCalledWith({
      level: 'ask-sensitive',
      autoResume: false,
      scope: 'project',
    });
  });

  it('can be dismissed with Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
