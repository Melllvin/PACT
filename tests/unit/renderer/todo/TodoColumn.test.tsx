import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodoColumn } from '../../../../src/renderer/todo/TodoColumn';
import type { TodoItem } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// T082 — the À faire column (screens 1f, 1l): agent colors, the tile buttons, an empty state.

const waiting = agent(1, { color: 'cyan', state: 'awaiting-answer' });
const limited = agent(2, { color: 'green', state: 'error' });

const todos: TodoItem[] = [
  {
    id: `${waiting.id}:answer`,
    agentId: waiting.id,
    kind: 'answer',
    title: '◆ Répondre',
    actions: ['allow', 'deny'],
  },
  {
    id: `${limited.id}:rate-limit`,
    agentId: limited.id,
    kind: 'rate-limit',
    title: '✕ Limite de débit · Claude Code',
    actions: ['log', 'restart', 'resume'],
  },
  { id: 't1:info', agentId: 't1', kind: 'info', title: 'En cours ▸ zsh — main', actions: [] },
];

const setup = (items = todos) => {
  const actions = { onAnswer: vi.fn(), onResume: vi.fn(), onRestart: vi.fn(), onLog: vi.fn() };
  render(<TodoColumn todos={items} agents={[waiting, limited]} {...actions} />);
  return actions;
};

const item = (title: string) => screen.getByText(title).closest('li') ?? document.body;

describe('TodoColumn', () => {
  it('lists the items in the order given, each in the color of its agent', () => {
    setup();
    const list = screen.getByRole('list', { name: 'À faire' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('◆ Répondre'),
      expect.stringContaining('✕ Limite de débit'),
      'En cours ▸ zsh — main',
    ]);
    expect(item('◆ Répondre').style.getPropertyValue('--agent-color')).toBe('var(--agent-cyan)');
    expect(item('En cours ▸ zsh — main').style.getPropertyValue('--agent-color')).toBe('');
  });

  it('answers from the column with the buttons of the tile (FR-028)', async () => {
    const user = userEvent.setup();
    const actions = setup();
    const answer = within(item('◆ Répondre'));
    await user.click(answer.getByRole('button', { name: '✓ Autoriser' }));
    await user.click(answer.getByRole('button', { name: '✕ Refuser' }));
    expect(actions.onAnswer.mock.calls).toEqual([
      [waiting.id, 'allow'],
      [waiting.id, 'deny'],
    ]);
  });

  it('recovers from a rate limit with « Journal », « Relancer » and « Reprendre »', async () => {
    const user = userEvent.setup();
    const actions = setup();
    const limit = within(item('✕ Limite de débit · Claude Code'));
    await user.click(limit.getByRole('button', { name: 'Journal' }));
    await user.click(limit.getByRole('button', { name: 'Relancer' }));
    await user.click(limit.getByRole('button', { name: 'Reprendre' }));
    expect(actions.onLog).toHaveBeenCalledWith(limited.id);
    expect(actions.onRestart).toHaveBeenCalledWith(limited.id);
    expect(actions.onResume).toHaveBeenCalledWith(limited.id);
  });

  it('says there is nothing to do (US4 scenario 5)', () => {
    setup([]);
    expect(screen.getByText('Rien à faire · vous serez prévenu')).toBeDefined();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
