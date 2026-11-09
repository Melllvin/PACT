import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodoItem } from '../../../../src/renderer/todo/TodoItem';
import { agent } from '../tiles/fixtures';

// 008 T045 — « ◆ CI muette » (Attendre encore, Relire) and « ◆ Livraison » (Ouvrir la PR, Compris), US4 sc.2, sc.5.

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const URL = 'https://github.com/pact/test/pull/7';
const dev = agent(2, { state: 'done', role: 'dev' });

const setup = (kind: 'delivery-silent-ci' | 'delivery-alert', title: string) => {
  const onDecideDelivery = vi.fn();
  const onOpenPr = vi.fn();
  render(
    <ul>
      <TodoItem
        todo={
          {
            id: `d1:${kind}`,
            agentId: dev.id,
            kind,
            title,
            actions: [],
            delivery: { id: 'd1', head: HEAD, url: URL },
          } as never
        }
        agent={dev}
        {...({ onDecideDelivery, onOpenPr } as object)}
      />
    </ul>,
  );
  return { onDecideDelivery, onOpenPr, user: userEvent.setup() };
};

describe('delivery-silent-ci', () => {
  const title = '◆ CI muette · PR #7 · 10 min sans check';

  it('Given the item, When it is shown, Then it offers « Attendre encore » and « Relire », and nothing to validate', () => {
    setup('delivery-silent-ci', title);

    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('delivery-silent-ci');
    expect(screen.getByText('◆ CI muette')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attendre encore' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Relire' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fusionner' })).toBeNull();
  });

  it('Given the item, When « Attendre encore » is clicked, Then the wait is asked on the head shown', async () => {
    const { onDecideDelivery, onOpenPr, user } = setup('delivery-silent-ci', title);

    await user.click(screen.getByRole('button', { name: 'Attendre encore' }));

    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith('d1', 'wait', HEAD);
    expect(onOpenPr).not.toHaveBeenCalled();
  });

  it('Given the item, When « Relire » is clicked, Then the answer is sent and the PR is opened', async () => {
    const { onDecideDelivery, onOpenPr, user } = setup('delivery-silent-ci', title);

    await user.click(screen.getByRole('button', { name: 'Relire' }));

    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith('d1', 'review', HEAD);
    expect(onOpenPr).toHaveBeenCalledExactlyOnceWith('d1');
  });
});

describe('delivery-alert', () => {
  const title = '◆ Livraison · 0012-connexion · 3 recalages de suite';

  it('Given the item, When it is shown, Then it offers « Ouvrir la PR » and « Compris »', () => {
    setup('delivery-alert', title);

    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('delivery-alert');
    expect(screen.getByRole('button', { name: 'Ouvrir la PR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compris' })).toBeTruthy();
  });

  it('Given the item, When « Ouvrir la PR » then « Compris » are clicked, Then the PR is opened and the alert is answered', async () => {
    const { onDecideDelivery, onOpenPr, user } = setup('delivery-alert', title);

    await user.click(screen.getByRole('button', { name: 'Ouvrir la PR' }));
    await user.click(screen.getByRole('button', { name: 'Compris' }));

    expect(onOpenPr).toHaveBeenCalledExactlyOnceWith('d1');
    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith('d1', 'wait', HEAD);
  });
});
