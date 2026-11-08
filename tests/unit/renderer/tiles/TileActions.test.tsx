import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileActions } from '../../../../src/renderer/tiles/TileActions';
import type { AgentState } from '../../../../src/shared/model';

// 002 T018 — « Revue → » for an agent with changes to review (FR-002).

const handlers = () => ({
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
});

describe('TileActions « Revue → »', () => {
  it.each<AgentState>(['done', 'awaiting-prompt'])(
    'opens the review of an agent %s',
    async (state) => {
      const user = userEvent.setup();
      const onReview = vi.fn();
      render(<TileActions state={state} {...handlers()} onReview={onReview} />);
      await user.click(screen.getByRole('button', { name: 'Revue →' }));
      expect(onReview).toHaveBeenCalled();
    },
  );

  it('is absent without changes to review', () => {
    render(<TileActions state="done" {...handlers()} />);
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
  });

  it('leaves the answer buttons alone while the agent asks something', () => {
    render(<TileActions state="awaiting-answer" {...handlers()} onReview={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
    expect(screen.getByRole('button', { name: '✓ Autoriser' })).toBeDefined();
  });
});

// T162 — a question is answered in the terminal, never with « 1 » (FR-024a).
describe('TileActions for a question', () => {
  it('opens the terminal instead of offering Autoriser / Refuser', async () => {
    const user = userEvent.setup();
    const props = handlers();
    const onOpenTerminal = vi.fn();
    render(
      <TileActions
        state="awaiting-answer"
        question
        {...props}
        onAlways={vi.fn()}
        onOpenTerminal={onOpenTerminal}
      />,
    );
    expect(screen.queryByRole('button', { name: '✓ Autoriser' })).toBeNull();
    expect(screen.queryByRole('button', { name: '✕ Refuser' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Toujours pour ce worktree' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Répondre dans le terminal ↗' }));
    expect(onOpenTerminal).toHaveBeenCalled();
    expect(props.onAnswer).not.toHaveBeenCalled();
  });
});

// 006 FR-025 — the tile of an agent closed with its orchestrator offers to start it again.
describe('TileActions of a closed agent', () => {
  it('offers « Relancer » and « Journal »', async () => {
    const user = userEvent.setup();
    const h = handlers();
    render(<TileActions state="closed" {...h} />);
    await user.click(screen.getByRole('button', { name: 'Relancer' }));
    await user.click(screen.getByRole('button', { name: 'Journal' }));
    expect(h.onRestart).toHaveBeenCalledOnce();
    expect(h.onLog).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Reprendre' })).toBeNull();
  });
});

// 006 T039 (US5, FR-027, FR-028) and T045 (#45) — the ⋮ menu of the tile and of the Focus.
// Assumed API of TileActions, all optional (no menu without them): `menu` = {
//   promote?: { reason: string | null; working: boolean; onConfirm: () => void };
//   rename?: { name: string; onRename: (name: string) => void } }.
// The menu is the button « Plus d’actions »; « Faire orchestrateur » is a menuitem, disabled with
// its reason (`reason` non-null); confirming goes through a dialog « Faire orchestrateur ? ».
describe('TileActions menu « Faire orchestrateur »', () => {
  const open = async (
    promote: { reason: string | null; working: boolean; onConfirm: () => void },
    user = userEvent.setup(),
  ) => {
    render(<TileActions state="awaiting-prompt" {...handlers()} menu={{ promote }} />);
    await user.click(screen.getByRole('button', { name: 'Plus d’actions' }));
    return user;
  };

  it('Given no orchestrator and a CLI that can be one, When the menu opens, Then the option is there and enabled (FR-027)', async () => {
    await open({ reason: null, working: false, onConfirm: vi.fn() });
    const item = screen.getByRole('menuitem', { name: 'Faire orchestrateur' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('Given an orchestrator already, When the menu opens, Then the option is disabled with the reason (scenario 2)', async () => {
    const reason = 'Claude Code 1 est déjà l’orchestrateur';
    const onConfirm = vi.fn();
    const user = await open({ reason, working: false, onConfirm });
    const item = screen.getByRole('menuitem', { name: /Faire orchestrateur/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(reason)).toBeDefined();
    await user.click(item);
    expect(screen.queryByRole('dialog', { name: 'Faire orchestrateur ?' })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Given a CLI that cannot be orchestrator, When the menu opens, Then the option is disabled with the reason (scenario 3)', async () => {
    const reason = 'Ce CLI ne sait pas être orchestrateur';
    await open({ reason, working: false, onConfirm: vi.fn() });
    expect(
      screen.getByRole('menuitem', { name: /Faire orchestrateur/ }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByText(reason)).toBeDefined();
  });

  it('Given an idle agent, When the option is chosen and confirmed, Then onConfirm runs, with no warning of interruption', async () => {
    const onConfirm = vi.fn();
    const user = await open({ reason: null, working: false, onConfirm });
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    const dialog = screen.getByRole('dialog', { name: 'Faire orchestrateur ?' });
    expect(dialog.textContent).not.toMatch(/interrompu/);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('Given an agent at work, When the option is chosen, Then the dialog warns that it restarts and its task is interrupted (scenario 5)', async () => {
    const onConfirm = vi.fn();
    const user = await open({ reason: null, working: true, onConfirm });
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    const dialog = screen.getByRole('dialog', { name: 'Faire orchestrateur ?' });
    expect(dialog.textContent).toMatch(/redémarre/);
    expect(dialog.textContent).toMatch(/interrompue/);
  });

  it('Given the dialog, When cancelled, Then nothing happens', async () => {
    const onConfirm = vi.fn();
    const user = await open({ reason: null, working: false, onConfirm });
    await user.click(screen.getByRole('menuitem', { name: 'Faire orchestrateur' }));
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Faire orchestrateur ?' })).toBeNull();
  });
});

describe('TileActions menu « Renommer » (#45)', () => {
  const setup = async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(
      <TileActions
        state="awaiting-prompt"
        {...handlers()}
        menu={{ rename: { name: 'Claude Code 2', onRename } }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Plus d’actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Renommer' }));
    return { user, onRename };
  };

  it('Given the menu, When « Renommer » is chosen, Then a field holds the current name', async () => {
    await setup();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Nom de l’agent' }).value).toBe(
      'Claude Code 2',
    );
  });

  it('Given a new name, When validated, Then onRename gets it trimmed', async () => {
    const { user, onRename } = await setup();
    const field = screen.getByRole('textbox', { name: 'Nom de l’agent' });
    await user.clear(field);
    await user.type(field, '  Relecteur ');
    await user.keyboard('{Enter}');
    expect(onRename).toHaveBeenCalledWith('Relecteur');
  });

  it('Given an empty name, When validated, Then onRename is not called', async () => {
    const { user, onRename } = await setup();
    await user.clear(screen.getByRole('textbox', { name: 'Nom de l’agent' }));
    await user.keyboard('{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('Given Escape, When the field is open, Then the rename is dropped', async () => {
    const { user, onRename } = await setup();
    await user.keyboard('{Escape}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Nom de l’agent' })).toBeNull();
  });
});
