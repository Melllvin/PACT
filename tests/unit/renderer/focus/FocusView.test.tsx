import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FocusView, type FocusTab as FocusTabName } from '../../../../src/renderer/focus/FocusView';
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

  // 004 US4 — the Aperçu, once given, is a tab like the others (FR-025).
  it('enables Aperçu once given and shows it on its tab', async () => {
    const user = userEvent.setup();
    const onTab = vi.fn();
    const names = (cliId: string) => cliId;
    const props = {
      agents: team(),
      agentId: agent(1).id,
      name: names,
      terminals: { attach: vi.fn(() => () => undefined) },
      onTab,
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onAnswer: vi.fn(),
      onResume: vi.fn(),
      onRestart: vi.fn(),
      onLog: vi.fn(),
      onCancelAutoResume: vi.fn(),
    };
    const { rerender } = render(<FocusView {...props} preview={<p>Maquettes</p>} />);
    await user.click(screen.getByRole('tab', { name: 'Aperçu' }));
    expect(onTab).toHaveBeenCalledWith('preview');
    rerender(<FocusView {...props} tab="preview" preview={<p>Maquettes</p>} />);
    expect(screen.getByText('Maquettes')).toBeDefined();
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

  // T162 — a question is answered in the agent's terminal (FR-024a).
  it('opens the terminal tab for a question instead of answering it', async () => {
    const user = userEvent.setup();
    const { props } = setup(
      team({ state: 'awaiting-answer', awaiting: 'question' }),
      undefined,
      'changes',
    );
    await user.click(screen.getByRole('button', { name: 'Répondre dans le terminal ↗' }));
    expect(props.onTab).toHaveBeenCalledWith('terminal');
    expect(props.onAnswer).not.toHaveBeenCalled();
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

// 007 T043 — the journal « ◎ Actions » merges the messages of the exchanges with the actions of the
// orchestrator, by time, the latest first (contracts/ui.md « Onglet ◎ Actions »).
//
// API fixed here for the dev (see the report, « API fixées »): `orchestration.messages?:
// ExchangeMessage[]` (empty by default). A message is a `<li>` of the same list; it shows the time,
// « <sender> → <recipient> » by the names of the agents (« PACT » for `pact`), its type (`action` or
// `info`), its kind and its text; it carries `data-type="action" | "info"`, and an `info` is dimmed
// by that attribute alone (state events: turn-finished, closed).
describe('FocusView of the orchestrator — the exchanges in the journal', () => {
  const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const message = (
    n: number,
    hour: number,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: uuidOf(100 + n),
    at: `2026-11-08T${String(hour).padStart(2, '0')}:00:00.000Z`,
    from: agent(2).id,
    to: agent(3).id,
    type: 'action',
    kind: 'message',
    text: `Message ${String(n)}`,
    unreadBy: [],
    ...over,
  });
  const action = (n: number, hour: number) => ({
    id: uuidOf(n),
    at: `2026-11-08T${String(hour).padStart(2, '0')}:00:00.000Z`,
    tool: 'send_prompt' as const,
    agentId: agent(2).id,
    summary: `Consigne ${String(n)}`,
    outcome: 'ok' as const,
    reason: null,
  });

  const renderJournal = (
    messages: Record<string, unknown>[],
    actions = [action(1, 8), action(2, 12)],
  ) => {
    const journal = { messages };
    render(
      <FocusView
        agents={team({ role: 'orchestrator' })}
        agentId={agent(1).id}
        name={() => 'Claude Code'}
        terminals={undefined}
        tab="actions"
        onTab={vi.fn()}
        orchestration={{ actions, onRevoke: vi.fn(), ...journal }}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
      />,
    );
    return within(screen.getByRole('list', { name: 'Actions de l’orchestrateur' })).getAllByRole(
      'listitem',
    );
  };

  it('Given actions and messages, When the journal is shown, Then they are merged by time, the latest first', () => {
    const items = renderJournal([message(1, 10), message(2, 14), message(3, 6)]);
    expect(items.map((item) => /(Message|Consigne) \d/.exec(item.textContent)?.[0])).toEqual([
      'Message 2',
      'Consigne 2',
      'Message 1',
      'Consigne 1',
      'Message 3',
    ]);
  });

  it('Given a message between two agents, When it is shown, Then it has the sender, the recipient, the type, the kind and the text', () => {
    const [item] = renderJournal([message(1, 10, { kind: 'question', text: 'Quelle base ?' })], []);
    const text = item?.textContent ?? '';
    expect(text).toMatch(/Claude Code 2\s*→\s*Claude Code 3/);
    expect(text).toContain('action');
    expect(text).toContain('question');
    expect(text).toContain('Quelle base ?');
    expect(item?.getAttribute('data-type')).toBe('action');
  });

  it('Given an event of PACT, When it is shown, Then the sender is PACT', () => {
    const [item] = renderJournal(
      [message(1, 10, { from: 'pact', kind: 'report', text: 'Fait' })],
      [],
    );
    expect(item?.textContent).toMatch(/PACT\s*→\s*Claude Code 3/);
  });

  it('Given an info of state, When it is shown, Then it is there and marked info, to be dimmed', () => {
    const items = renderJournal(
      [
        message(1, 10, { from: 'pact', type: 'info', kind: 'turn-finished', text: 'Tour fini' }),
        message(2, 11),
      ],
      [],
    );
    const info = items.find((item) => item.textContent.includes('Tour fini'));
    expect(info?.getAttribute('data-type')).toBe('info');
    expect(info?.textContent).toContain('turn-finished');
    expect(
      items.find((item) => item.textContent.includes('Message 2'))?.getAttribute('data-type'),
    ).toBe('action');
  });

  it('Given a text of an agent with markup, When it is shown, Then it is text, never HTML', () => {
    const hostile = '<img src=x onerror="alert(1)"><b>gras</b>';
    const items = renderJournal([message(1, 10, { text: hostile })], []);
    expect(items[0]?.textContent).toContain(hostile);
    expect(items[0]?.querySelector('img')).toBeNull();
    expect(items[0]?.querySelector('b')).toBeNull();
  });

  it('Given no message, When the journal is shown, Then the actions alone are listed as before', () => {
    const items = renderJournal([]);
    expect(items).toHaveLength(2);
  });

  it('Given only messages, When the journal is shown, Then « Aucune action » is not shown', () => {
    renderJournal([message(1, 10)], []);
    expect(screen.queryByText('Aucune action pour l’instant.')).toBeNull();
  });
});

// 006 T043 (#42) and #43 — a tab other than Terminal fills the tile; the terminal is hidden, not
// destroyed; a tab without content is not offered.
describe('FocusView tabs (#42, #43)', () => {
  const hidden = (el: HTMLElement) => {
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      if (
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true' ||
        node.hasAttribute('inert') ||
        node.style.display === 'none' ||
        node.classList.contains('hidden')
      )
        return true;
    }
    return false;
  };
  const mount = (agents: Agent[], tab: FocusTabName, extra: Record<string, unknown> = {}) => {
    const detach = vi.fn();
    const terminals = { attach: vi.fn(() => detach) };
    const view = (current: FocusTabName) => (
      <FocusView
        agents={agents}
        agentId={agents[0]?.id ?? ''}
        name={() => 'Claude Code'}
        terminals={terminals}
        tab={current}
        onTab={vi.fn()}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onRestart={vi.fn()}
        onLog={vi.fn()}
        onCancelAutoResume={vi.fn()}
        onClose={vi.fn()}
        changes={<p>Liste des changements</p>}
        {...extra}
      />
    );
    const utils = render(view(tab));
    return { ...utils, view, detach, terminals };
  };
  const lead = () => [agent(1, { role: 'orchestrator' }), agent(2)];
  const orchestration = { actions: [], onRevoke: vi.fn() };

  it.each([
    ['changes', 'Liste des changements'],
    ['reports', 'Les rapports'],
    ['actions', 'Aucune action pour l’instant.'],
    ['preview', 'Mon aperçu'],
  ] as const)(
    'Given the %s tab of an orchestrator, When shown, Then the terminal is not visible and the panel is',
    (tab, text) => {
      mount(lead(), tab, {
        orchestration,
        reports: <p>Les rapports</p>,
        preview: <p>Mon aperçu</p>,
      });
      expect(screen.getByText(text)).toBeDefined();
      expect(hidden(screen.getByLabelText('Terminal de Claude Code 1'))).toBe(true);
    },
  );

  it('Given a simple agent on Changements, When shown, Then its terminal is not visible either', () => {
    mount([agent(1)], 'changes');
    expect(hidden(screen.getByLabelText('Terminal de Claude Code 1'))).toBe(true);
  });

  it('Given the Terminal tab, When shown, Then the terminal is visible', () => {
    mount([agent(1)], 'terminal');
    expect(hidden(screen.getByLabelText('Terminal de Claude Code 1'))).toBe(false);
  });

  it('Given a panel tab, When shown, Then the panel is not squeezed above a terminal strip (no 32 % band)', () => {
    mount([agent(1)], 'changes');
    const box = screen.getByLabelText('Terminal de Claude Code 1').closest('[class*="h-["]');
    expect(box).toBeNull();
  });

  it('Given a tab left and Terminal again, When switched, Then the terminal was never detached (session kept)', () => {
    const { rerender, view, detach, terminals } = mount([agent(1)], 'terminal');
    rerender(view('changes'));
    rerender(view('terminal'));
    expect(detach).not.toHaveBeenCalled();
    expect(terminals.attach).toHaveBeenCalledTimes(1);
  });

  it('Given no preview given, When the tabs show, Then there is no Aperçu tab at all (#43)', () => {
    mount([agent(1)], 'terminal');
    expect(screen.queryByRole('tab', { name: 'Aperçu' })).toBeNull();
  });

  it('Given no reports and no journal, When the tabs show, Then neither Actions nor Rapports is offered (#43)', () => {
    mount([agent(1)], 'terminal');
    expect(screen.queryByRole('tab', { name: /Actions/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Rapports/ })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeDefined();
  });
});
