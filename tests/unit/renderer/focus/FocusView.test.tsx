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

const setup = (
  agents = team(),
  agentId = agents[0]?.id ?? '',
  tab: 'terminal' | 'changes' = 'terminal',
) => {
  const props = {
    onTab: vi.fn(),
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
      tab={tab}
      changes={<p>Liste des changements</p>}
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

  it('has the Terminal tab active, Changements enabled and Aperçu still disabled (FR-001)', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(terminal.getAttribute('aria-selected')).toBe('true');
    const preview = screen.getByRole('tab', { name: 'Aperçu' });
    expect((preview as HTMLButtonElement).disabled).toBe(true);
    const changes = screen.getByRole('tab', { name: 'Changements' });
    expect((changes as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Liste des changements')).toBeNull();
    await user.click(changes);
    expect(props.onTab).toHaveBeenCalledWith('changes');
  });

  it('shows the changes above the same terminal on the Changements tab (screen 1h)', () => {
    const { terminals } = setup(team(), agent(1).id, 'changes');
    expect(screen.getByRole('tab', { name: 'Changements' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('Liste des changements')).toBeDefined();
    expect(screen.getByLabelText('Terminal de Claude Code 1')).toBeDefined();
    expect(terminals.attach).toHaveBeenCalledWith(agent(1).id, expect.any(HTMLElement));
  });

  it('goes back to the tiles with Escape from the changes', () => {
    const { props } = setup(team(), agent(1).id, 'changes');
    fireEvent.keyDown(screen.getByText('Liste des changements'), { key: 'Escape' });
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('offers one pill per agent in its color, the current one checked', () => {
    setup();
    const pills = within(screen.getByRole('radiogroup', { name: 'Agents' })).getAllByRole('radio');
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
    expect(pills.map((pill) => pill.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  it('switches to another agent from its pill (US5 scenario 2)', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('radio', { name: 'Codex 2' }));
    expect(props.onSelect).toHaveBeenCalledWith(agent(2).id);
  });

  it('stays on the current agent when its pill is pressed again', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('radio', { name: 'Claude Code 1' }));
    expect(props.onSelect).not.toHaveBeenCalled();
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

// 003 T041 — the journal « ◎ Actions » and « Retirer le rôle d'orchestrateur » (FR-004, FR-021).
describe('FocusView of the orchestrator', () => {
  const action = (n: number, outcome: 'ok' | 'refused' = 'ok') => ({
    id: `00000000-0000-4000-8000-00000000000${String(n)}`,
    at: `2026-11-03T0${String(n)}:00:00.000Z`,
    tool: 'send_prompt' as const,
    agentId: agent(2).id,
    summary: `Consigne ${String(n)}`,
    outcome,
    reason: outcome === 'refused' ? 'Aucun agent « Faux CLI 9 »' : null,
  });

  const renderLead = (onRevoke = vi.fn(), tab: 'terminal' | 'actions' = 'actions') => {
    const onTab = vi.fn();
    render(
      <FocusView
        agents={team({ role: 'orchestrator' })}
        agentId={agent(1).id}
        name={() => 'Claude Code'}
        terminals={undefined}
        tab={tab}
        onTab={onTab}
        orchestration={{ actions: [action(2, 'refused'), action(1)], onRevoke }}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
      />,
    );
    return { onTab, onRevoke };
  };

  it('offers « ◎ Actions » for the orchestrator only', async () => {
    const user = userEvent.setup();
    const { onTab } = renderLead(vi.fn(), 'terminal');
    await user.click(screen.getByRole('tab', { name: '◎ Actions' }));
    expect(onTab).toHaveBeenCalledWith('actions');
  });

  it('has no « ◎ Actions » for another agent', () => {
    setup();
    expect(screen.queryByRole('tab', { name: '◎ Actions' })).toBeNull();
  });

  it('lists the actions, the latest first, with the reason of a refusal', () => {
    renderLead();
    const items = within(screen.getByRole('list', { name: 'Actions de l’orchestrateur' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Consigne 2');
    expect(items[0]).toContain('Aucun agent « Faux CLI 9 »');
    expect(items[1]).toContain('Consigne 1');
  });

  it('asks before withdrawing the role', async () => {
    const user = userEvent.setup();
    const { onRevoke } = renderLead();
    await user.click(screen.getByRole('button', { name: 'Retirer le rôle d’orchestrateur' }));
    expect(onRevoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onRevoke).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retirer le rôle d’orchestrateur' }));
    await user.click(screen.getByRole('button', { name: 'Retirer' }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });
});

describe('FocusView and the roles (004 T018, FR-006)', () => {
  it('shows the role of the agent in its header', () => {
    const { focus } = setup(team({ role: 'dev' }));
    expect(within(focus()).getByLabelText('Rôle').textContent).toBe('Dev');
  });

  it('shows no role for an ordinary agent', () => {
    const { focus } = setup();
    expect(within(focus()).queryByLabelText('Rôle')).toBeNull();
  });
});
