import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FocusView } from '../../../../src/renderer/focus/FocusView';
import type { Agent } from '../../../../src/shared/model';
import { agent, rateLimited, scheduledResume, time } from '../tiles/fixtures';

// T087 — Focus on one agent (US5, FR-034, screen 1p).

const team = (first: Partial<Agent> = {}) => [
  agent(1, { color: 'purple', branch: 'agent/pg-sessions', ...first }),
  agent(2, { color: 'cyan', cliId: 'codex' }),
  agent(3, { color: 'green', state: 'awaiting-answer' }),
];

const setup = (agents = team(), agentId = agents[0]?.id ?? '') => {
  const props = {
    onSelect: vi.fn(),
    onBack: vi.fn(),
    onAnswer: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLog: vi.fn(),
    onCancelAutoResume: vi.fn(),
    onClose: vi.fn(),
  };
  const terminals = { attach: vi.fn(() => () => undefined) };
  const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
  render(
    <FocusView
      agents={agents}
      agentId={agentId}
      name={(cliId) => names[cliId] ?? cliId}
      terminals={terminals}
      {...props}
    />,
  );
  const focus = () => screen.getByRole('region', { name: /^Focus/ });
  return { props, terminals, focus };
};

describe('FocusView', () => {
  it('shows the agent terminal large, bordered with its color', () => {
    const { focus, terminals } = setup();
    expect(focus().getAttribute('aria-label')).toBe('Focus : Claude Code 1');
    expect(focus().style.getPropertyValue('--agent-color')).toBe('var(--agent-purple)');
    expect(terminals.attach).toHaveBeenCalledWith(agent(1).id, expect.any(HTMLElement));
    expect(screen.getByLabelText('Terminal de Claude Code 1')).toBeDefined();
  });

  it('shows the branch and the port in the header (US5 scenario 1)', () => {
    const { focus } = setup();
    expect(within(focus()).getByText('agent/pg-sessions · :3001', { exact: false })).toBeDefined();
  });

  it('has the Terminal tab active; Aperçu and Changements are shown but disabled', () => {
    setup();
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(terminal.getAttribute('aria-selected')).toBe('true');
    for (const name of ['Aperçu', 'Changements']) {
      const tab = screen.getByRole('tab', { name });
      expect(tab.getAttribute('aria-selected')).toBe('false');
      expect((tab as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('offers one pill per agent in its color, the current one pressed', () => {
    setup();
    const pills = within(screen.getByRole('group', { name: 'Agents' })).getAllByRole('button');
    expect(pills.map((pill) => pill.getAttribute('aria-label'))).toEqual([
      'Claude Code 1',
      'Codex 2',
      'Claude Code 3, attend votre réponse',
    ]);
    expect(pills.map((pill) => pill.style.getPropertyValue('--agent-color'))).toEqual([
      'var(--agent-purple)',
      'var(--agent-cyan)',
      'var(--agent-green)',
    ]);
    expect(pills.map((pill) => pill.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('switches to another agent from its pill (US5 scenario 2)', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: 'Codex 2' }));
    expect(props.onSelect).toHaveBeenCalledWith(agent(2).id);
  });

  it('goes back to the tiles with « ‹ Tuiles » (US5 scenario 3)', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: '‹ Tuiles' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('goes back to the tiles with Escape outside the terminal', () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: '‹ Tuiles' }), { key: 'Escape' });
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape typed in the terminal to the CLI', () => {
    const { props } = setup();
    const terminal = screen.getByLabelText('Terminal de Claude Code 1');
    const input = terminal.appendChild(document.createElement('textarea'));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(props.onBack).not.toHaveBeenCalled();
  });

  it('leaves Escape to an open dialog', () => {
    const { props } = setup();
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(props.onBack).not.toHaveBeenCalled();
    dialog.remove();
  });

  it('answers a request, and offers « Toujours pour ce worktree » (US5 scenario 4)', async () => {
    const user = userEvent.setup();
    const agents = team({ state: 'awaiting-answer' });
    const { props } = setup(agents);
    await user.click(screen.getByRole('button', { name: 'Toujours pour ce worktree' }));
    await user.click(screen.getByRole('button', { name: '✕ Refuser' }));
    await user.click(screen.getByRole('button', { name: '✓ Autoriser' }));
    expect(props.onAnswer.mock.calls).toEqual([
      [agent(1).id, 'allow', true],
      [agent(1).id, 'deny'],
      [agent(1).id, 'allow'],
    ]);
  });

  it('offers the recovery actions of an agent in error', async () => {
    const user = userEvent.setup();
    const { props } = setup(team({ state: 'error' }));
    await user.click(screen.getByRole('button', { name: 'Reprendre' }));
    await user.click(screen.getByRole('button', { name: 'Journal' }));
    await user.click(screen.getByRole('button', { name: 'Relancer' }));
    expect(props.onResume).toHaveBeenCalledWith(agent(1).id);
    expect(props.onLog).toHaveBeenCalledWith(agent(1).id);
    expect(props.onRestart).toHaveBeenCalledWith(agent(1).id);
  });

  it('shows the scheduled resume with « Annuler » (FR-036)', async () => {
    const user = userEvent.setup();
    const { props } = setup(team({ ...rateLimited, scheduledResume }));
    expect(screen.getByText(`reprise auto à ${time}`)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(props.onCancelAutoResume).toHaveBeenCalledWith(agent(1).id);
  });
});
