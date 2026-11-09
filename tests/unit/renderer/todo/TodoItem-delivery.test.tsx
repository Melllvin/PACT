import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodoItem } from '../../../../src/renderer/todo/TodoItem';
import { agent } from '../tiles/fixtures';

// 008 T016 — « ◎ Fusionner <agent> → <main> ? » (delivery-local, US1 sc.7, sc.12, FR-027).
//
// RED until T022. Assumed API: the item is `{ kind: 'delivery-local', delivery: { id, head } }`
// and TodoItem takes `onDecideDelivery(deliveryId, decision: 'validate' | 'refuse', head)`;
// « Fusionner » validates, « Refuser » refuses.

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const dev = agent(2, { state: 'done', role: 'dev' });

const setup = (title = '◎ Fusionner Claude Code 2 → main ?') => {
  const onDecideDelivery = vi.fn();
  const props = {
    onAnswer: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLog: vi.fn(),
    onCancelAutoResume: vi.fn(),
    onReview: vi.fn(),
    onDecideDelivery,
  };
  render(
    <ul>
      <TodoItem
        todo={
          {
            id: 'd1:delivery-local',
            agentId: dev.id,
            kind: 'delivery-local',
            title,
            actions: [],
            delivery: { id: 'd1', head: HEAD },
          } as never
        }
        agent={dev}
        {...(props as object)}
      />
    </ul>,
  );
  return { onDecideDelivery, user: userEvent.setup() };
};

describe('delivery-local', () => {
  it('Given the item, When it is shown, Then the title reads who and what, and the buttons are « Fusionner » and « Refuser »', () => {
    setup();

    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('delivery-local');
    expect(screen.getByText('◎ Fusionner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fusionner' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✓ Intégrer' })).toBeNull();
  });

  it('Given the item, When « Fusionner » is clicked, Then the delivery is validated on the head shown', async () => {
    const { onDecideDelivery, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Fusionner' }));

    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith('d1', 'validate', HEAD);
  });

  it('Given a click on « Fusionner », When the answer has not come, Then the button is disabled and a second click asks nothing (FR-027)', async () => {
    const { onDecideDelivery, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Fusionner' }));
    await user.click(screen.getByRole('button', { name: 'Fusionner' }));

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fusionner' }).disabled).toBe(
      true,
    );
    expect(onDecideDelivery).toHaveBeenCalledOnce();
  });

  it('Given an item without a verdict, When it is shown, Then the title says so', () => {
    setup('◎ Fusionner Claude Code 2 → main ? · sans verdict');

    expect(screen.getByText(/sans verdict/)).toBeTruthy();
  });
});

describe('delivery-review, « Ouvrir la PR »', () => {
  const review = (url?: string) => {
    const onOpenPr = vi.fn();
    render(
      <ul>
        <TodoItem
          todo={
            {
              id: 'd1:delivery-review',
              agentId: dev.id,
              kind: 'delivery-review',
              title: '◎ Relire la PR #7',
              actions: [],
              delivery: { id: 'd1', head: HEAD, verdict: 'accepted', ...(url ? { url } : {}) },
            } as never
          }
          agent={dev}
          {...({ onOpenPr, onDecideDelivery: vi.fn() } as object)}
        />
      </ul>,
    );
    return { onOpenPr, user: userEvent.setup() };
  };

  it('Given the link, When it is clicked, Then the main process is asked to open the PR of that delivery and the page does not navigate', async () => {
    const { onOpenPr, user } = review('https://github.com/pact/test/pull/7');

    await user.click(screen.getByRole('link', { name: 'Ouvrir la PR' }));

    expect(onOpenPr).toHaveBeenCalledExactlyOnceWith('d1');
  });

  it('Given an item without an address, When it is shown, Then there is no link', () => {
    review();

    expect(screen.queryByRole('link', { name: 'Ouvrir la PR' })).toBeNull();
  });

  it('Given no handler, When the link is clicked, Then nothing breaks', async () => {
    render(
      <ul>
        <TodoItem
          todo={
            {
              id: 'd1:delivery-review',
              agentId: dev.id,
              kind: 'delivery-review',
              title: '◎ Relire la PR #7',
              actions: [],
              delivery: {
                id: 'd1',
                head: HEAD,
                verdict: null,
                url: 'https://github.com/a/b/pull/1',
              },
            } as never
          }
          agent={dev}
        />
      </ul>,
    );

    await userEvent.click(screen.getByRole('link', { name: 'Ouvrir la PR' }));
    await userEvent.click(screen.getByRole('button', { name: 'Valider' }));

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Valider' }).disabled).toBe(true);
  });
});
