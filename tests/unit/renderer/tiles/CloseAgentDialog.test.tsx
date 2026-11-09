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

// 008 T050 (US6 sc.6, contracts/ui.md) — closing by oneself an agent in a delivery says what will
// happen: « Une livraison est en cours (PR #n) : elle sera abandonnée, la PR restera ouverte. »
//
// RED until T053. ASSUMED PROP (ui.md fixes the text, not the prop; listed in the report): `delivery`,
// `{ prNumber: number | null }` — the request of the agent that is not final, `null` for a number
// when the PR is not opened yet — absent when the agent is in no delivery. App.tsx derives it from
// `workspace.deliveries`. It is passed through a loose object, as above, so that the tests fail on
// the missing behavior and not on the typing.
describe('CloseAgentDialog of an agent in a delivery (008 sc.6)', () => {
  const WARNING =
    'Une livraison est en cours (PR #12) : elle sera abandonnée, la PR restera ouverte.';

  it('warns, with the number of the PR, that the delivery will be abandoned and the PR left open', () => {
    setupGroup({ delivery: { prNumber: 12 } });
    const dialog = screen.getByRole('dialog', { name: 'Fermer Claude Code 1' });
    expect(within(dialog).getByText(WARNING)).toBeDefined();
  });

  it('warns as well before the PR exists, without a number that is not there', () => {
    setupGroup({ delivery: { prNumber: null } });
    const dialog = screen.getByRole('dialog', { name: 'Fermer Claude Code 1' });
    expect(within(dialog).getByText(/Une livraison est en cours/)).toBeDefined();
    expect(dialog.textContent).not.toMatch(/PR #(null|undefined|NaN)/);
  });

  it('says nothing of the sort for an agent that is in no delivery', () => {
    setupGroup({});
    expect(screen.getByRole('dialog').textContent).not.toContain('livraison');
  });

  it('does not take the choice away: the user still keeps or removes the worktree, and confirms', async () => {
    const { onConfirm, onCancel } = setupGroup({ delivery: { prNumber: 12 } });
    expect(screen.getByRole('radio', { name: /Conserver/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('radio', { name: /Supprimer/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Fermer l’agent' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('can still be given up with « Annuler »: the delivery goes on', async () => {
    const { onConfirm, onCancel } = setupGroup({ delivery: { prNumber: 12 } });
    await userEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
