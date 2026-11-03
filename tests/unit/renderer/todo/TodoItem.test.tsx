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

// T162 — a question in À faire opens the agent's terminal (FR-024a).
describe('TodoItem for a question', () => {
  it('opens the terminal of the agent of the item', async () => {
    const user = userEvent.setup();
    const props = { ...actions(), onOpenTerminal: vi.fn() };
    const asking = agent(1, { state: 'awaiting-answer', awaiting: 'question' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: `${asking.id}:answer`,
            agentId: asking.id,
            kind: 'answer',
            title: '◆ Répondre',
            actions: ['open-terminal'],
          }}
          agent={asking}
          {...props}
        />
      </ul>,
    );
    expect(screen.queryByRole('button', { name: '✓ Autoriser' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Répondre dans le terminal ↗' }));
    expect(props.onOpenTerminal).toHaveBeenCalledWith(asking.id);
  });
});
