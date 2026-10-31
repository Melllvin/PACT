import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../../../../src/renderer/focus/FocusView';
import { agent } from '../tiles/fixtures';

// 002 T051 — in the Revue view, the pills go from one agent to review to the next (FR-003).

describe('FocusView pills in the Revue view', () => {
  it('offers only the agents given as pills, the Focus still on the current one', () => {
    const agents = [agent(1), agent(2), agent(3)];
    render(
      <FocusView
        agents={agents}
        pills={[agents[0], agents[2]].filter((a) => a !== undefined)}
        agentId={agent(1).id}
        name={() => 'Claude Code'}
        terminals={undefined}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
      />,
    );
    const pills = within(screen.getByRole('radiogroup', { name: 'Agents' })).getAllByRole('radio');
    expect(pills.map((pill) => pill.getAttribute('aria-label'))).toEqual([
      'Claude Code 1',
      'Claude Code 3',
    ]);
  });
});

describe('FocusView Conflits tab (002 T050)', () => {
  it('offers « Conflits · N » while an integration is stopped, and shows it above the terminal', async () => {
    const onTab = vi.fn();
    const props = {
      agents: [agent(1)],
      agentId: agent(1).id,
      name: () => 'Claude Code',
      terminals: undefined,
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onAnswer: vi.fn(),
      onResume: vi.fn(),
      onRestart: vi.fn(),
      onLog: vi.fn(),
      onCancelAutoResume: vi.fn(),
      onTab,
      conflicts: { count: 2, content: <p>Écran 1q</p> },
    };
    const { rerender } = render(<FocusView {...props} tab="changes" />);
    expect(screen.queryByText('Écran 1q')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Conflits · 2' }));
    expect(onTab).toHaveBeenCalledWith('conflicts');
    rerender(<FocusView {...props} tab="conflicts" />);
    expect(screen.getByText('Écran 1q')).toBeDefined();
  });

  it('shows nothing for an agent that is gone', () => {
    const { container } = render(
      <FocusView
        agents={[agent(1)]}
        agentId={agent(2).id}
        name={() => 'Claude Code'}
        terminals={undefined}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
