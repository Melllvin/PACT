import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TileActions } from '../../../../src/renderer/tiles/TileActions';

// 008 T022 — the edges of the dialogs of « Livrer » / « Intégrer »: what each one says, how it is left.

const setup = (remote: boolean, accepted: boolean) => {
  const onRequest = vi.fn();
  render(
    <TileActions
      state="done"
      onAnswer={vi.fn()}
      onResume={vi.fn()}
      onRestart={vi.fn()}
      onLog={vi.fn()}
      onCancelAutoResume={vi.fn()}
      delivery={{ remote, accepted, title: 'Connexion', onRequest }}
    />,
  );
  return { onRequest, user: userEvent.setup() };
};

describe('« Intégrer » of a repository without a remote', () => {
  it('Given an accepted loop, When « Intégrer » is confirmed, Then the merge is asked with a verdict', async () => {
    const { onRequest, user } = setup(false, true);

    await user.click(screen.getByRole('button', { name: 'Intégrer' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('La fusion te sera demandée dans À faire.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmer' }));

    expect(onRequest).toHaveBeenCalledWith({
      title: 'Connexion',
      message: 'Connexion',
      unverified: false,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Given the dialog, When it is cancelled, Then nothing is asked and it closes', async () => {
    const { onRequest, user } = setup(false, true);

    await user.click(screen.getByRole('button', { name: 'Intégrer' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler' }));

    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('leaving a dialog with Escape', () => {
  it.each([
    [false, 'Intégrer'],
    [true, 'Livrer'],
  ])(
    'Given the dialog of %s remote=%s, When Escape is pressed, Then it closes',
    async (remote, name) => {
      const { onRequest, user } = setup(remote, true);

      await user.click(screen.getByRole('button', { name }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onRequest).not.toHaveBeenCalled();
    },
  );
});

describe('« Livrer »', () => {
  it('Given the dialog, When it is cancelled, Then nothing is asked and it closes', async () => {
    const { onRequest, user } = setup(true, true);

    await user.click(screen.getByRole('button', { name: 'Livrer' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Annuler' }));

    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Given an empty message, When the form is submitted anyway, Then nothing is asked', async () => {
    const { onRequest, user } = setup(true, true);

    await user.click(screen.getByRole('button', { name: 'Livrer' }));
    const form = within(screen.getByRole('dialog'))
      .getByRole('button', { name: 'Demander' })
      .closest('form');
    fireEvent.submit(form as HTMLFormElement);

    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
