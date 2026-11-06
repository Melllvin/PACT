import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentsColumn } from '../../../../src/renderer/agents/AgentsColumn';
import type { AgentRow, AgentsView } from '../../../../src/shared/agents-view';
import type { Agent, TodoItem } from '../../../../src/shared/model';
import { agent, rateLimited, scheduledResume, time } from '../tiles/fixtures';

// 006 T012 — the Agents column (contracts/ui.md « Colonne »), which replaces the À faire column
// (cases of TodoColumn kept): head items, one row per agent, the existing actions stay clickable.

const waiting = agent(1, { color: 'cyan', state: 'awaiting-answer' });
const limited = agent(2, {
  color: 'green',
  ...rateLimited,
  scheduledResume: { ...scheduledResume, agentId: agent(2).id },
});
const lead = agent(3, { role: 'orchestrator', state: 'working' });

const answer: TodoItem = {
  id: `${waiting.id}:answer`,
  agentId: waiting.id,
  kind: 'answer',
  title: '◆ Répondre',
  actions: ['allow', 'deny'],
};
const limit: TodoItem = {
  id: `${limited.id}:rate-limit`,
  agentId: limited.id,
  kind: 'rate-limit',
  title: '✕ Limite de débit · Claude Code',
  actions: ['log', 'restart', 'resume'],
};
const integration: TodoItem = {
  id: 'req-1:integration-request',
  agentId: waiting.id,
  kind: 'integration-request',
  title: '◎ Intégrer Claude Code 1 → main ?',
  actions: [],
  request: { id: 'req-1', message: 'feat: x' },
};
const info: TodoItem = {
  id: 't1:info',
  agentId: 't1',
  kind: 'info',
  title: 'En cours ▸ zsh — main',
  actions: [],
};

const row = (a: Agent, todo: TodoItem | null, state: string): AgentRow => ({
  agent: a,
  name: `Claude Code ${String(a.position)}`,
  role: a.role,
  stateLabel: state,
  issueId: null,
  todo,
  pending: todo ? 1 : 0,
});

const full: AgentsView = {
  head: [integration, info],
  rows: [
    row(waiting, answer, 'attend une réponse'),
    row(limited, limit, 'limite de débit'),
    row(lead, null, 'travaille'),
  ],
  agentCount: 3,
  pendingCount: 3,
};

const setup = (view: AgentsView = full) => {
  const actions = {
    onOpen: vi.fn(),
    onAnswer: vi.fn(),
    onResume: vi.fn(),
    onRestart: vi.fn(),
    onLog: vi.fn(),
    onCancelAutoResume: vi.fn(),
    onConfirmIntegration: vi.fn(),
    onRefuseIntegration: vi.fn(),
  };
  render(<AgentsColumn view={view} {...actions} />);
  return actions;
};

const item = (title: string) => screen.getByText(title).closest('li') ?? document.body;

describe('AgentsColumn', () => {
  it('is a complementary region « Agents »', () => {
    setup();
    expect(screen.getByRole('complementary', { name: 'Agents' })).toBeDefined();
  });

  it('is titled « Agents N » with « M à traiter » when M > 0', () => {
    setup();
    const heading = screen.getByRole('heading', { level: 2, name: /^Agents/ });
    expect(heading.textContent).toContain('Agents 3');
    expect(heading.textContent).toContain('3 à traiter');
  });

  it('says nothing about « à traiter » when nothing waits', () => {
    setup({ head: [], rows: [row(lead, null, 'travaille')], agentCount: 1, pendingCount: 0 });
    const heading = screen.getByRole('heading', { level: 2, name: /^Agents/ });
    expect(heading.textContent).toContain('Agents 1');
    expect(heading.textContent).not.toContain('à traiter');
  });

  it('lists the head items in « À traiter », then the agents in « Agents du workspace »', () => {
    setup();
    const lists = screen.getAllByRole('list');
    expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual([
      'À traiter',
      'Agents du workspace',
    ]);
    expect(
      within(screen.getByRole('list', { name: 'À traiter' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('Intégrer'), 'En cours ▸ zsh — main']);
    expect(
      within(screen.getByRole('list', { name: 'Agents du workspace' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });

  it('omits « À traiter » when the head is empty, and keeps the agents', () => {
    setup({ head: [], rows: [row(lead, null, 'travaille')], agentCount: 1, pendingCount: 0 });
    expect(screen.queryByRole('list', { name: 'À traiter' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Agents du workspace' })).toBeDefined();
  });

  it('keeps the rows in the order given, each in the color of its agent', () => {
    setup();
    const rows = within(screen.getByRole('list', { name: 'Agents du workspace' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Claude Code 1'),
      expect.stringContaining('Claude Code 2'),
      expect.stringContaining('Claude Code 3'),
    ]);
    expect(rows[0]?.style.getPropertyValue('--agent-color')).toBe('var(--agent-cyan)');
  });

  it('opens an agent from its row', async () => {
    const actions = setup();
    await userEvent.click(screen.getByRole('button', { name: /^Claude Code 3, orchestrateur/i }));
    expect(actions.onOpen).toHaveBeenCalledWith(lead.id);
  });

  it('answers from the column with the buttons of the tile (FR-028)', async () => {
    const user = userEvent.setup();
    const actions = setup();
    const answerRow = within(item('◆ Répondre'));
    await user.click(answerRow.getByRole('button', { name: '✓ Autoriser' }));
    await user.click(answerRow.getByRole('button', { name: '✕ Refuser' }));
    expect(actions.onAnswer.mock.calls).toEqual([
      [waiting.id, 'allow'],
      [waiting.id, 'deny'],
    ]);
  });

  it('recovers from a rate limit with « Journal », « Relancer » and « Reprendre »', async () => {
    const user = userEvent.setup();
    const actions = setup();
    const row2 = within(item('✕ Limite de débit'));
    await user.click(row2.getByRole('button', { name: 'Journal' }));
    await user.click(row2.getByRole('button', { name: 'Relancer' }));
    await user.click(row2.getByRole('button', { name: 'Reprendre' }));
    expect(actions.onLog).toHaveBeenCalledWith(limited.id);
    expect(actions.onRestart).toHaveBeenCalledWith(limited.id);
    expect(actions.onResume).toHaveBeenCalledWith(limited.id);
  });

  it('shows the scheduled resume of the rate limit, with « Annuler » (FR-036)', async () => {
    const actions = setup();
    const limitRow = within(item('✕ Limite de débit'));
    expect(limitRow.getByText(`reprise auto à ${time}`)).toBeDefined();
    await userEvent.click(limitRow.getByRole('button', { name: 'Annuler' }));
    expect(actions.onCancelAutoResume).toHaveBeenCalledWith(limited.id);
  });

  it('confirms and refuses an integration request from the head (003 FR-017)', async () => {
    const actions = setup();
    const request = within(item('◎ Intégrer Claude Code 1 → main ?'));
    await userEvent.click(request.getByRole('button', { name: /Intégrer/ }));
    await userEvent.click(request.getByRole('button', { name: 'Refuser' }));
    expect(actions.onConfirmIntegration).toHaveBeenCalledWith('req-1', 'feat: x');
    expect(actions.onRefuseIntegration).toHaveBeenCalledWith('req-1');
  });

  it('shows the kind of request apart from its agent and hint (1f)', () => {
    setup({
      head: [],
      rows: [
        row(
          waiting,
          {
            id: `${waiting.id}:prompt`,
            agentId: waiting.id,
            kind: 'prompt',
            title: 'Donner une consigne · Claude Code · tapez dans le terminal',
            actions: [],
          },
          'attend une consigne',
        ),
      ],
      agentCount: 1,
      pendingCount: 1,
    });
    expect(screen.getByText('Donner une consigne')).toBeDefined();
    expect(screen.getByText('tapez dans le terminal')).toBeDefined();
  });
});
