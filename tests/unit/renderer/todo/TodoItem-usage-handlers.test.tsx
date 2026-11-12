import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodoItem } from '../../../../src/renderer/todo/TodoItem';

// 009 — « ◆ En pause »: each button acts only if its handler is given, and none shows without one.

const todo = {
  id: 'usage:claude-code:default:usage-paused' as const,
  agentId: 'usage:claude-code:default',
  kind: 'usage-paused' as const,
  title: '◆ En pause · Claude Code · limite 5 h à 91 % · reprise 16:40',
  actions: [],
  usageLimit: { cliId: 'claude-code', account: 'default', kind: 'paused' as const },
};
const base = {
  onAnswer: vi.fn(),
  onResume: vi.fn(),
  onRestart: vi.fn(),
  onLog: vi.fn(),
  onCancelAutoResume: vi.fn(),
};
const show = (extra: Record<string, unknown>) =>
  render(
    <ul>
      <TodoItem todo={todo} agent={undefined} {...base} {...extra} />
    </ul>,
  );

describe('TodoItem usage-paused handlers', () => {
  it('does nothing on « Reprendre » when only the cancel handler is given', async () => {
    const cancel = vi.fn();
    show({ onUsageCancelResume: cancel });
    await userEvent.click(screen.getByRole('button', { name: 'Reprendre' }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does nothing on « Annuler la reprise » when only the resume handler is given', async () => {
    const resume = vi.fn();
    show({ onUsageResume: resume });
    await userEvent.click(screen.getByRole('button', { name: 'Annuler la reprise' }));
    expect(resume).not.toHaveBeenCalled();
  });

  it('shows no button without any handler', () => {
    show({});
    expect(screen.queryByRole('button')).toBeNull();
  });
});
