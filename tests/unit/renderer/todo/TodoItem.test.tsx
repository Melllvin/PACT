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

// 004 T029 — « ◎ Créer N issues ? »: nothing is published before the user says so (FR-023).
describe('TodoItem of issues to publish', () => {
  it.each([
    ['✓ Créer', 'onConfirmPublish'],
    ['Refuser', 'onRefusePublish'],
  ] as const)('« %s » answers the request', async (label, handler) => {
    const user = userEvent.setup();
    const callbacks = { onConfirmPublish: vi.fn(), onRefusePublish: vi.fn() };
    const lead = agent(1, { state: 'working', role: 'orchestrator' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: 'r1:publish-issues',
            agentId: lead.id,
            kind: 'publish-issues',
            title: '◎ Créer 2 issues ? · Claude Code 1 · Connexion, Export CSV',
            actions: [],
            publish: { requestId: 'r1' },
          }}
          agent={lead}
          {...actions()}
          {...callbacks}
        />
      </ul>,
    );
    expect(screen.getByText('◎ Créer 2 issues ?')).toBeTruthy();
    expect(screen.getByText('Connexion, Export CSV')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
    await user.click(screen.getByRole('button', { name: label }));
    expect(callbacks[handler]).toHaveBeenCalledWith('r1');
  });
});

// 005 T019 — the usage alert, its color and « Détail », which opens the gauge (FR-011).
describe('TodoItem usage alert', () => {
  const alert = (level: 'warn' | 'critical') => ({
    id: 'usage:claude-code:default:usage-limit' as const,
    agentId: 'usage:claude-code:default',
    kind: 'usage-limit' as const,
    title: '◆ Limite Claude Code à 85 % · 5 h · réinitialisation 16:40',
    actions: [],
    usage: { cliId: 'claude-code', account: 'default', level },
  });

  it('opens the detail of its gauge, in the color of its level', async () => {
    const onUsageDetail = vi.fn();
    const { rerender } = render(
      <ul>
        <TodoItem
          todo={alert('warn')}
          agent={undefined}
          {...actions()}
          onUsageDetail={onUsageDetail}
        />
      </ul>,
    );
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('◆ Limite Claude Code à 85 %');
    expect(item.textContent).toContain('réinitialisation 16:40');
    expect(item.className).toContain('border-waiting/30');
    await userEvent.click(screen.getByRole('button', { name: 'Détail' }));
    expect(onUsageDetail).toHaveBeenCalledWith('usage:claude-code:default');
    rerender(
      <ul>
        <TodoItem
          todo={alert('critical')}
          agent={undefined}
          {...actions()}
          onUsageDetail={onUsageDetail}
        />
      </ul>,
    );
    expect(screen.getByRole('listitem').className).toContain('border-destructive/30');
  });
});
