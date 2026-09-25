import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionsDialog } from '../../../../src/renderer/launch/PermissionsDialog';
import type { CliDefinition } from '../../../../src/shared/model';

// Screen 1m — asked once, on the first launch (FR-012, FR-035, US2 scenario 1).

type Cli = Pick<CliDefinition, 'id' | 'name' | 'adapter'>;
const claude: Cli = { id: 'claude-code', name: 'Claude Code', adapter: 'claude-code' };
const codex: Cli = { id: 'codex', name: 'Codex', adapter: 'codex' };

const renderDialog = (clis: Cli[] = [claude, codex]) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <PermissionsDialog agentCount={3} clis={clis} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { onConfirm, onCancel };
};

const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });
/** Radix radios and checkboxes are buttons: their state is in aria-checked. */
const checked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';

describe('PermissionsDialog', () => {
  it('offers the three levels, « Toujours autoriser » preselected', () => {
    renderDialog();
    expect(checked(radio('Toujours autoriser'))).toBe(true);
    expect(checked(radio('Demander pour les actions sensibles'))).toBe(false);
    expect(checked(radio('Toujours demander'))).toBe(false);
  });

  it('describes what each level really allows, without promising confinement', () => {
    renderDialog();
    const text = document.body.textContent;
    expect(text).not.toMatch(/agissent seuls dans leur worktree/);
    expect(text).toMatch(/sans vous demander/);
    expect(text).toMatch(/git push/);
    expect(text).toMatch(/attend votre accord/);
  });

  it('describes each level for each CLI launched (FR-012, research R5)', () => {
    renderDialog();
    const allowAll = radio('Toujours autoriser').closest('label')?.textContent ?? '';
    expect(allowAll).toMatch(/Claude Code.*hors de son worktree/);
    expect(allowAll).toMatch(/Codex.*sandbox/);
    const sensitive = radio('Demander pour les actions sensibles').closest('label')?.textContent;
    expect(sensitive).toMatch(/Claude Code.*git push/);
    expect(sensitive).toMatch(/Codex.*juge/);
  });

  it('promises Codex nothing that only Claude Code rules guarantee', () => {
    renderDialog([codex]);
    const text = document.body.textContent;
    expect(text).not.toMatch(/git push|Claude Code/);
    expect(text).toMatch(/sandbox/);
  });

  it('describes other CLIs without promising anything they do not enforce', () => {
    renderDialog([{ id: 'custom-aider', name: 'Aider', adapter: 'generic' }]);
    const text = document.body.textContent;
    expect(text).not.toMatch(/git push|sandbox/);
    expect(text).toMatch(/Aider.*ses propres réglages/);
  });

  it('offers the « Ce projet » and « Tous les projets » scopes', () => {
    renderDialog();
    expect(checked(radio('Tous les projets'))).toBe(true);
    expect(checked(radio('Ce projet'))).toBe(false);
  });

  it('resumes automatically after a rate limit by default (FR-035)', () => {
    renderDialog();
    const option = screen.getByRole('checkbox', {
      name: 'Reprendre automatiquement après une limite de débit',
    });
    expect(checked(option)).toBe(true);
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

  it('marks the default level and says Enter picks it (1m)', () => {
    renderDialog();
    const allowAll = radio('Toujours autoriser').closest('label');
    expect(allowAll && within(allowAll).getByText('défaut')).toBeTruthy();
    expect(screen.getByText('Entrée = choix par défaut')).toBeDefined();
    expect(screen.getByRole('radiogroup', { name: 'S’applique à' })).toBeDefined();
  });

  it('launches the choices made with Enter too', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(radio('Toujours demander'));
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledWith({
      level: 'always-ask',
      autoResume: true,
      scope: 'global',
    });
  });

  it('keeps the focus inside the dialog (modal dialog)', async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Autorisations des agents' });
    for (let step = 0; step < 10; step++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('can be dismissed with Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
