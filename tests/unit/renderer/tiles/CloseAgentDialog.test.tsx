import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
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
    expect(screen.getByRole('radio', { name: /Conserver/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
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

  it('leaves Enter on « Annuler » to the button: cancels without closing the agent', async () => {
    const { onConfirm, onCancel } = setup();
    screen.getByRole('button', { name: 'Annuler' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('keeps the focus inside the dialog (modal dialog)', async () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Fermer Claude Code 1' });
    for (let step = 0; step < 6; step++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});

// 006 US4 (T034) — closing the orchestrator closes the agents it launched: the dialog lists them and
// its worktree choice applies to all of them (FR-023). The props read here do not exist yet; they
// are passed through a loose object so that the tests fail on the missing behavior.
const subAgents = [
  { id: 'a2', name: 'Claude Code 2' },
  { id: 'a3', name: 'Codex 3' },
];

const setupGroup = (extra: object = { subAgents }) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CloseAgentDialog
      name="Claude Code 1"
      branch="feature/login"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...extra}
    />,
  );
  return { onConfirm, onCancel };
};

describe('CloseAgentDialog of an orchestrator', () => {
  it('lists the agents it launched, which close with it', () => {
    setupGroup();
    const dialog = screen.getByRole('dialog', { name: 'Fermer Claude Code 1' });
    expect(within(dialog).getByText('Claude Code 2')).toBeDefined();
    expect(within(dialog).getByText('Codex 3')).toBeDefined();
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps every worktree by default, and applies « Supprimer » to all', async () => {
    const { onConfirm } = setupGroup();
    expect(screen.getByRole('radio', { name: /Conserver/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenLastCalledWith(false);
    await userEvent.click(screen.getByRole('radio', { name: /Supprimer/ }));
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenLastCalledWith(true);
  });

  it('lists nothing for an agent that launched none', () => {
    setupGroup({ subAgents: [] });
    expect(within(screen.getByRole('dialog')).queryAllByRole('listitem')).toHaveLength(0);
  });
});

// « Reprendre le travail » is offered when the closed orchestrator is restarted (FR-026), checked by
// default. Its dialog is read from the module at run time: the component is not written yet.
type RestartProps = {
  name: string;
  subAgents: { id: string; name: string }[];
  onConfirm: (resumeWork: boolean) => void;
  onCancel: () => void;
};

const renderRestart = async () => {
  const module = (await import('../../../../src/renderer/tiles/CloseAgentDialog')) as Record<
    string,
    unknown
  >;
  const Restart = module['RestartGroupDialog'] as
    ((props: RestartProps) => ReactElement) | undefined;
  if (!Restart) throw new Error('RestartGroupDialog is not exported by CloseAgentDialog.tsx');
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <Restart
      name="Claude Code 1"
      subAgents={subAgents}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
};

describe('« Reprendre le travail » at the restart of an orchestrator', () => {
  it('is checked by default and sent as true', async () => {
    const { onConfirm } = await renderRestart();
    const box = screen.getByRole('checkbox', { name: /Reprendre le travail/ });
    expect(box.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Relancer' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('sends false once unchecked', async () => {
    const { onConfirm } = await renderRestart();
    await userEvent.click(screen.getByRole('checkbox', { name: /Reprendre le travail/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Relancer' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('names the agents restarted with the orchestrator, and cancels with « Annuler »', async () => {
    const { onConfirm, onCancel } = await renderRestart();
    expect(screen.getByText('Claude Code 2')).toBeDefined();
    expect(screen.getByText('Codex 3')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
