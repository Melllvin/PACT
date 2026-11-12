import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileActions } from '../../../../src/renderer/tiles/TileActions';

// 008 T016 — the delivery actions of an agent’s row (contracts/ui.md « Actions d’agent »; US1
// sc.11, sc.12).
//
// RED until T022. Assumed API: a prop `delivery` on TileActions, absent = no delivery action:
//   { remote: boolean; accepted: boolean; title: string;
//     onRequest: (request: { title: string; message: string; unverified: boolean }) => void }
// `accepted`: the agent is the dev of an `accepted` loop. `title`: the issue title, or the branch.
// The dialog of « Livrer » / « Créer la PR sans verdict » has a field « Titre » (pre-filled with
// `title`), a field « Message » and a submit button « Demander ». « Fusionner sans verdict »
// asks for a confirmation (« Confirmer »).

const handlers = () => ({
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
});

const setup = (delivery: { remote: boolean; accepted: boolean; title?: string }) => {
  const onRequest = vi.fn();
  render(
    <TileActions
      state="done"
      {...handlers()}
      {...({ delivery: { title: 'Connexion par e-mail', ...delivery, onRequest } } as object)}
    />,
  );
  return { onRequest, user: userEvent.setup() };
};

const button = (name: string) => screen.queryByRole<HTMLButtonElement>('button', { name });
const names = () =>
  ['Livrer', 'Créer la PR sans verdict', 'Intégrer', 'Fusionner sans verdict'].filter(
    (name) => button(name) !== null,
  );

describe('which actions, by remote and loop', () => {
  it('Given a remote and an accepted loop, When the row is shown, Then « Livrer » is the one action', () => {
    setup({ remote: true, accepted: true });

    expect(names()).toEqual(['Livrer']);
    expect(button('Livrer')?.disabled).toBe(false);
  });

  it('Given a remote and no loop, When the row is shown, Then « Livrer » is disabled with the reason, and « Créer la PR sans verdict » is offered', () => {
    setup({ remote: true, accepted: false });

    expect(names()).toEqual(['Livrer', 'Créer la PR sans verdict']);
    expect(button('Livrer')?.disabled).toBe(true);
    expect(button('Créer la PR sans verdict')?.disabled).toBe(false);
    const reason =
      screen.queryByText('demande une boucle acceptée') ??
      screen.queryByTitle('demande une boucle acceptée');
    expect(reason ?? button('Livrer')?.getAttribute('aria-description')).toBeTruthy();
  });

  it('Given no remote and an accepted loop, When the row is shown, Then « Intégrer » is the one action', () => {
    setup({ remote: false, accepted: true });

    expect(names()).toEqual(['Intégrer']);
    expect(button('Intégrer')?.disabled).toBe(false);
  });

  it('Given no remote and no loop, When the row is shown, Then « Intégrer » is disabled and « Fusionner sans verdict » is offered', () => {
    setup({ remote: false, accepted: false });

    expect(names()).toEqual(['Intégrer', 'Fusionner sans verdict']);
    expect(button('Intégrer')?.disabled).toBe(true);
    expect(button('Fusionner sans verdict')?.disabled).toBe(false);
  });

  it('Given no delivery prop, When the row is shown, Then no delivery action is offered', () => {
    render(<TileActions state="done" {...handlers()} />);

    expect(names()).toEqual([]);
  });
});

describe('the request of a delivery', () => {
  it('Given « Livrer », When it is clicked, Then a dialog asks for a title pre-filled with the issue’s and a message, and nothing is requested yet', async () => {
    const { onRequest, user } = setup({ remote: true, accepted: true });

    await user.click(screen.getByRole('button', { name: 'Livrer' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: /titre/i }).value).toBe(
      'Connexion par e-mail',
    );
    expect(within(dialog).getByRole('textbox', { name: /message/i })).toBeTruthy();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('Given the dialog filled, When it is sent, Then the request carries the title and the message, verified', async () => {
    const { onRequest, user } = setup({ remote: true, accepted: true });
    await user.click(screen.getByRole('button', { name: 'Livrer' }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByRole('textbox', { name: /message/i }), 'feat: connexion');
    await user.click(within(dialog).getByRole('button', { name: 'Demander' }));

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith({
      title: 'Connexion par e-mail',
      message: 'feat: connexion',
      unverified: false,
    });
  });

  it('Given an empty title, When the dialog is read, Then it cannot be sent', async () => {
    const { onRequest, user } = setup({ remote: true, accepted: true });
    await user.click(screen.getByRole('button', { name: 'Livrer' }));
    const dialog = screen.getByRole('dialog');

    await user.clear(within(dialog).getByRole('textbox', { name: /titre/i }));
    await user.type(within(dialog).getByRole('textbox', { name: /message/i }), 'feat');

    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Demander' }).disabled,
    ).toBe(true);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('Given « Créer la PR sans verdict », When it is sent, Then the request is marked unverified (sc.11)', async () => {
    const { onRequest, user } = setup({ remote: true, accepted: false, title: 'feat/seul' });
    await user.click(screen.getByRole('button', { name: 'Créer la PR sans verdict' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: /titre/i }).value).toBe(
      'feat/seul',
    );
    await user.type(within(dialog).getByRole('textbox', { name: /message/i }), 'feat: seul');
    await user.click(within(dialog).getByRole('button', { name: 'Demander' }));

    expect(onRequest).toHaveBeenCalledWith({
      title: 'feat/seul',
      message: 'feat: seul',
      unverified: true,
    });
  });

  it('Given « Fusionner sans verdict », When it is clicked, Then it asks to confirm and requests nothing before (sc.12)', async () => {
    const { onRequest, user } = setup({ remote: false, accepted: false });

    await user.click(screen.getByRole('button', { name: 'Fusionner sans verdict' }));
    expect(onRequest).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirmer' }));

    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ unverified: true }));
  });
});
