import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodoItem } from '../../../../src/renderer/todo/TodoItem';
import { agent } from '../tiles/fixtures';

// 002 T018 — « Revue → » in À faire opens the Changements tab of the agent (FR-002).

const actions = () => ({
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
  onReview: vi.fn(),
});

describe('TodoItem « Revue → »', () => {
  it('opens the review of the agent of the item', async () => {
    const user = userEvent.setup();
    const props = actions();
    const done = agent(1, { state: 'done' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: `${done.id}:review`,
            agentId: done.id,
            kind: 'review',
            title: 'Changements à relire · Claude Code',
            actions: ['review'],
          }}
          agent={done}
          {...props}
        />
      </ul>,
    );
    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('review');
    await user.click(screen.getByRole('button', { name: 'Revue →' }));
    expect(props.onReview).toHaveBeenCalledWith(done.id);
  });

  it('offers no review on a prompt request', () => {
    const waiting = agent(1);
    render(
      <ul>
        <TodoItem
          todo={{
            id: `${waiting.id}:prompt`,
            agentId: waiting.id,
            kind: 'prompt',
            title: 'Donner une consigne · Claude Code · tapez dans le terminal',
            actions: [],
          }}
          agent={waiting}
          {...actions()}
        />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
  });
});

// 003 T031 — « ◎ Intégrer <agent> → <main> ? »: the message stays the user's to change (FR-018).
describe('TodoItem of an integration the orchestrator asks for', () => {
  /** The actions, without « Revue → » when asked. */
  const without = <T extends { onReview: unknown }>(props: T, noReview: boolean) => {
    const { onReview, ...rest } = props;
    return noReview ? rest : { ...rest, onReview };
  };
  const setup = (overrides: { onReview?: boolean } = {}) => {
    const props = {
      ...actions(),
      onConfirmIntegration: vi.fn(),
      onRefuseIntegration: vi.fn(),
    };
    const done = agent(2, { state: 'done' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: 'r1:integration-request',
            agentId: done.id,
            kind: 'integration-request',
            title: '◎ Intégrer Claude Code 2 → main ?',
            actions: [],
            request: { id: 'r1', message: 'feat: connexion' },
          }}
          agent={done}
          {...without(props, overrides.onReview === false)}
        />
      </ul>,
    );
    return { props, done };
  };

  it('integrates with the message the user edited', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    expect(screen.getByText('◎ Intégrer Claude Code 2 → main ?')).toBeTruthy();
    const message = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message de commit' });
    expect(message.value).toBe('feat: connexion');
    await user.clear(message);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '✓ Intégrer' }).disabled).toBe(
      true,
    );
    await user.type(message, 'feat: connexion relue ');
    await user.click(screen.getByRole('button', { name: '✓ Intégrer' }));
    expect(props.onConfirmIntegration).toHaveBeenCalledWith('r1', 'feat: connexion relue');
    // Not a tile action: no « Autoriser » nor « Relancer » here.
    expect(screen.queryByRole('button', { name: /Autoriser|Relancer/ })).toBeNull();
  });

  it('refuses, or opens the review of the agent', async () => {
    const user = userEvent.setup();
    const { props, done } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(props.onRefuseIntegration).toHaveBeenCalledWith('r1');
    await user.click(screen.getByRole('button', { name: 'Revue →' }));
    expect(props.onReview).toHaveBeenCalledWith(done.id);
  });

  it('offers no review without one', () => {
    setup({ onReview: false });
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
  });
});

// 004 T022 — the user decides on a loop stopped after 3 rounds (FR-018).
describe('TodoItem of a loop stopped after 3 rounds', () => {
  it.each([
    ['Relancer 3 tours', 'restart'],
    ['Reprendre la main', 'take-over'],
    ['Abandonner', 'abandon'],
  ] as const)('« %s » decides %s', async (label, decision) => {
    const user = userEvent.setup();
    const onDecideLoop = vi.fn();
    const dev = agent(2, { state: 'done', role: 'dev' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: '0012-connexion:loop-escalated',
            agentId: dev.id,
            kind: 'loop-escalated',
            title: '✕ Boucle arrêtée · 0012-connexion · 3 tours',
            actions: [],
            loop: { issueId: '0012-connexion' },
          }}
          agent={dev}
          {...actions()}
          onDecideLoop={onDecideLoop}
        />
      </ul>,
    );
    expect(screen.getByText('✕ Boucle arrêtée')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
    await user.click(screen.getByRole('button', { name: label }));
    expect(onDecideLoop).toHaveBeenCalledWith('0012-connexion', decision);
  });
});
