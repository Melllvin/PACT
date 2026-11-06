import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentRow } from '../../../../src/renderer/agents/AgentRow';
import type { AgentRow as Row } from '../../../../src/shared/agents-view';
import type { Agent, TodoItem } from '../../../../src/shared/model';
import { agent } from '../tiles/fixtures';

// 006 T011 — one row of the Agents column (contracts/ui.md « Colonne »): a main button that opens
// the agent, and the action buttons only when an action is due.

const rowOf = (a: Agent, overrides: Partial<Row> = {}): Row => ({
  agent: a,
  name: `Claude Code ${String(a.position)}`,
  role: a.role,
  stateLabel: 'travaille',
  issueId: null,
  todo: null,
  pending: 0,
  ...overrides,
});

const answerTodo = (a: Agent): TodoItem => ({
  id: `${a.id}:answer`,
  agentId: a.id,
  kind: 'answer',
  title: '◆ Répondre',
  actions: ['allow', 'deny'],
});

const setup = (row: Row) => {
  const props = {
    onOpen: vi.fn(),
    onAnswer: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLog: vi.fn(),
    onCancelAutoResume: vi.fn(),
  };
  render(
    <ul>
      <AgentRow row={row} {...props} />
    </ul>,
  );
  return props;
};

describe('AgentRow', () => {
  it('names its main button « <Nom>, <rôle>, <état> »', () => {
    setup(rowOf(agent(1, { role: 'orchestrator', state: 'working' })));
    expect(
      screen.getByRole('button', { name: /^Claude Code 1, orchestrateur, travaille$/i }),
    ).toBeDefined();
  });

  it('adds « , issue <id> » when the issue is known', () => {
    const dev = agent(2, { role: 'dev', state: 'working' });
    setup(rowOf(dev, { issueId: '0001' }));
    expect(
      screen.getByRole('button', { name: /^Claude Code 2, dev, travaille, issue 0001$/i }),
    ).toBeDefined();
  });

  it('has no action button when no action is due', () => {
    setup(rowOf(agent(1, { state: 'working' })));
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('shows the action of its todo, and answers with it', async () => {
    const waiting = agent(3, { role: 'dev', state: 'awaiting-answer' });
    const props = setup(
      rowOf(waiting, { stateLabel: 'attend une réponse', todo: answerTodo(waiting), pending: 1 }),
    );
    expect(screen.getByText('◆ Répondre')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: '✓ Autoriser' }));
    expect(props.onAnswer).toHaveBeenCalledWith(waiting.id, 'allow');
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('opens the agent on a click of the main button', async () => {
    const a = agent(1, { state: 'working' });
    const props = setup(rowOf(a));
    await userEvent.click(screen.getByRole('button', { name: /^Claude Code 1/ }));
    expect(props.onOpen).toHaveBeenCalledWith(a.id);
  });

  it('opens the agent on Enter on the main button', async () => {
    const a = agent(1, { state: 'working' });
    const props = setup(rowOf(a));
    screen.getByRole('button', { name: /^Claude Code 1/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenCalledWith(a.id);
  });

  it('nests no button in another button', () => {
    const waiting = agent(3, { state: 'awaiting-answer' });
    setup(rowOf(waiting, { todo: answerTodo(waiting), pending: 1 }));
    for (const button of within(screen.getByRole('listitem')).getAllByRole('button')) {
      expect(button.querySelector('button')).toBeNull();
      expect(button.closest('button')).toBe(button);
    }
  });
});
