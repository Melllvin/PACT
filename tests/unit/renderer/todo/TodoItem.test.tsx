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

// 003 T031, migrated by 008 T023 — « ◎ Fusionner <agent> → <main> ? »: the merge the user is asked for.
describe('TodoItem of a merge the user is asked for', () => {
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  /** The actions, without « Revue → » when asked. */
  const without = <T extends { onReview: unknown }>(props: T, noReview: boolean) => {
    const { onReview, ...rest } = props;
    return noReview ? rest : { ...rest, onReview };
  };
  const setup = (overrides: { onReview?: boolean } = {}) => {
    const props = {
      ...actions(),
      onDecideDelivery: vi.fn(),
    };
    const done = agent(2, { state: 'done' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: 'r1:delivery-local',
            agentId: done.id,
            kind: 'delivery-local',
            title: '◎ Fusionner Claude Code 2 → main ?',
            actions: [],
            delivery: { id: 'r1', head: HEAD },
          }}
          agent={done}
          {...without(props, overrides.onReview === false)}
        />
      </ul>,
    );
    return { props, done };
  };

  it('merges on the head it shows', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: 'Fusionner' }));
    expect(props.onDecideDelivery).toHaveBeenCalledWith('r1', 'validate', HEAD);
    // Not a tile action: no « Autoriser » nor « Relancer » here.
    expect(screen.queryByRole('button', { name: /Autoriser|Relancer/ })).toBeNull();
  });

  it('refuses, or opens the review of the agent', async () => {
    const user = userEvent.setup();
    const { props, done } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));
    expect(props.onDecideDelivery).toHaveBeenCalledWith('r1', 'refuse', HEAD);
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

describe('TodoItem « Réveil en attente » (007 FR-014)', () => {
  it('shows the sentence under the title', () => {
    const held = agent(1, { state: 'awaiting-prompt' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: `${held.id}:wake-held`,
            agentId: held.id,
            kind: 'wake-held',
            title: '◆ Réveil en attente · Claude Code · saisie en cours',
            actions: [],
            detail: 'Videz l’invite ou envoyez votre saisie.',
          }}
          agent={held}
          {...actions()}
        />
      </ul>,
    );
    expect(screen.getByText('Videz l’invite ou envoyez votre saisie.')).toBeTruthy();
  });
});

// 007 T043 — « ✕ Échanges en boucle » (contracts/ui.md « Colonne Agents »): the last message as plain
// text, « Laisser reprendre » and « Couper », reachable with the keyboard.
//
// API fixed here for the dev (see the report, « API fixées »): `TodoItem.exchange = { escalationId,
// text }` (see todo.test.ts) and the handler `onDecideExchange(escalationId, 'resume' | 'cut')`.
describe('TodoItem of an exchange in a loop', () => {
  const dev = agent(2, { state: 'done', role: 'dev' });
  const todoOf = (text: string) =>
    ({
      id: 'e1:exchange-escalated',
      agentId: dev.id,
      kind: 'exchange-escalated',
      title: '✕ Échanges en boucle · Claude Code 2 ↔ Claude Code 3 · 3 allers-retours',
      actions: [],
      exchange: { escalationId: 'e1', text },
    }) as unknown as Parameters<typeof TodoItem>[0]['todo'];

  const show = (text = 'Relis le contrat.', handlers: Record<string, unknown> = {}) => {
    const onDecideExchange = vi.fn();
    const { container } = render(
      <ul>
        <TodoItem
          todo={todoOf(text)}
          agent={dev}
          {...actions()}
          {...{ onDecideExchange, ...handlers }}
        />
      </ul>,
    );
    return { onDecideExchange, container };
  };

  it('Given an escalation, When it is shown, Then the title names the two agents and the round trips, and the last message is there', () => {
    show('Je ne suis pas d’accord.');
    const item = screen.getByRole('listitem');
    expect(item.getAttribute('data-kind')).toBe('exchange-escalated');
    expect(item.textContent).toContain('✕ Échanges en boucle');
    expect(item.textContent).toContain('Claude Code 2 ↔ Claude Code 3');
    expect(item.textContent).toContain('3 allers-retours');
    expect(screen.getByText('Je ne suis pas d’accord.')).toBeTruthy();
  });

  it.each([
    ['Laisser reprendre', 'resume'],
    ['Couper', 'cut'],
  ] as const)(
    'Given the buttons, When « %s » is clicked, Then %s is decided for this escalation',
    async (label, decision) => {
      const user = userEvent.setup();
      const { onDecideExchange } = show();
      expect(screen.queryByRole('button', { name: 'Revue →' })).toBeNull();
      await user.click(screen.getByRole('button', { name: label }));
      expect(onDecideExchange).toHaveBeenCalledTimes(1);
      expect(onDecideExchange).toHaveBeenCalledWith('e1', decision);
    },
  );

  it('Given the keyboard, When the user tabs and presses Enter, Then both buttons are reached and decide', async () => {
    const user = userEvent.setup();
    const { onDecideExchange } = show();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Laisser reprendre' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Couper' }));
    await user.keyboard('{Enter}');
    expect(onDecideExchange).toHaveBeenCalledWith('e1', 'cut');
  });

  it('Given a message written by an agent with markup, When it is shown, Then it is text: no element is created from it', () => {
    const hostile = '<img src=x onerror="alert(1)"><b>gras</b><script>alert(2)</script>';
    const { container } = show(hostile);
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('Given no handler, When a button is clicked, Then nothing breaks', async () => {
    const user = userEvent.setup();
    const onDecideExchange = undefined;
    render(
      <ul>
        <TodoItem todo={todoOf('x')} agent={dev} {...actions()} {...{ onDecideExchange }} />
      </ul>,
    );
    await user.click(screen.getByRole('button', { name: 'Couper' }));
    expect(screen.getByRole('listitem')).toBeTruthy();
  });
});

// 008 T022 — a todo needs no handler it does not use.
describe('TodoItem without handlers', () => {
  it('shows the buttons of its agent and clicks through without a handler', async () => {
    const user = userEvent.setup();
    const failed = agent(5, {
      state: 'error',
      lastError: { code: null, kind: 'crash', message: 'Boum' },
    });
    render(
      <ul>
        <TodoItem
          todo={{
            id: 'a5:prompt',
            agentId: failed.id,
            kind: 'prompt',
            title: '✕ Erreur · claude-code 5',
            actions: [],
          }}
          agent={failed}
        />
      </ul>,
    );
    for (const name of ['Journal', 'Relancer', 'Reprendre']) {
      await user.click(screen.getByRole('button', { name }));
    }
    expect(screen.getByRole('listitem')).toBeTruthy();
  });
});

// 008 data-model — « ◎ Relire la PR #n »: shown with its agent, without the buttons of a tile.
describe('TodoItem of a PR to review', () => {
  it('shows the title and the work of its agent, and no button', () => {
    const dev = agent(6, { state: 'done' });
    render(
      <ul>
        <TodoItem
          todo={{
            id: 'd1:delivery-review',
            agentId: dev.id,
            kind: 'delivery-review',
            title: '◎ Relire la PR #3 · 0012-connexion · 1234567 · sans verdict',
            actions: [],
          }}
          agent={dev}
        />
      </ul>,
    );
    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('delivery-review');
    expect(screen.getByText(/Relire la PR #3/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

// 008 T037 — « ◎ Relire la PR #n » with its decisions (US3 sc.1 to 3, FR-013, FR-027, contracts/ui.md).
//
// RED until T040. Assumed API: the item is `{ kind: 'delivery-review', delivery: { id, head, url,
// verdict } }`, `head` being the head of the PR the user is asked to merge, `url` the link of the PR,
// `verdict` `'accepted'` or `null` (a PR without a verdict). TodoItem takes `onDecideDelivery(
// deliveryId, decision, head, reason?)`. « Valider » decides once and stays disabled until the item is
// gone; « Refuser » opens a field named « motif » and the button « Refuser » stays disabled while the
// reason is empty or blank; the reason is the fourth argument. « Ouvrir la PR » is a link to `url`.
describe('TodoItem « Relire la PR » (delivery-review)', () => {
  const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
  const PR_URL = 'https://github.com/pact/test/pull/7';
  const dev = agent(2, { state: 'done', role: 'dev' });

  const setup = (verdict: 'accepted' | null = 'accepted') => {
    const onDecideDelivery = vi.fn();
    render(
      <ul>
        <TodoItem
          todo={
            {
              id: 'd1:delivery-review',
              agentId: dev.id,
              kind: 'delivery-review',
              title:
                verdict === null
                  ? '◎ Relire la PR #7 · 0012-connexion · abcdef0 · sans verdict'
                  : '◎ Relire la PR #7 · 0012-connexion · abcdef0',
              actions: [],
              delivery: { id: 'd1', head: HEAD, url: PR_URL, verdict },
            } as never
          }
          agent={dev}
          {...{ ...actions(), onDecideDelivery }}
        />
      </ul>,
    );
    return { onDecideDelivery, user: userEvent.setup() };
  };

  it('Given the item, When it is shown, Then it gives the PR, the commit and the verdict, and the buttons Valider, Refuser and the link of the PR', () => {
    setup();

    expect(screen.getByRole('listitem').getAttribute('data-kind')).toBe('delivery-review');
    expect(screen.getAllByText(/Relire la PR #7/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/abcdef0/).length).toBeGreaterThan(0);
    expect(screen.getByRole('listitem').textContent).toMatch(/verdict/i);
    expect(screen.getByRole('listitem').textContent).not.toMatch(/sans verdict/i);
    expect(screen.getByRole('button', { name: 'Valider' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy();
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === PR_URL);
    expect(link).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fusionner' })).toBeNull();
  });

  it('Given a PR without a verdict, When it is shown, Then it says « sans verdict »', () => {
    setup(null);

    expect(screen.getByRole('listitem').textContent).toMatch(/sans verdict/);
  });

  it('Given the item, When Valider is clicked, Then the delivery is validated on the head shown', async () => {
    const { onDecideDelivery, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Valider' }));

    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith('d1', 'validate', HEAD);
  });

  it('Given a click on Valider, When the answer has not come, Then the button is disabled and a second click asks nothing (sc.2, FR-027)', async () => {
    const { onDecideDelivery, user } = setup();

    await user.click(screen.getByRole('button', { name: 'Valider' }));
    await user.click(screen.getByRole('button', { name: 'Valider' }));

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Valider' }).disabled).toBe(true);
    expect(onDecideDelivery).toHaveBeenCalledOnce();
  });

  it('Given the item, When it is shown, Then no field of reason is there until Refuser is clicked', async () => {
    const { onDecideDelivery, user } = setup();
    expect(screen.queryByRole('textbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Refuser' }));

    expect(screen.getByRole('textbox', { name: /motif/i })).toBeTruthy();
    expect(onDecideDelivery).not.toHaveBeenCalled();
  });

  it('Given the field of reason, When it is empty or blank, Then Refuser is disabled and a click asks nothing (sc.3)', async () => {
    const { onDecideDelivery, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));

    const refuse = screen.getByRole<HTMLButtonElement>('button', { name: 'Refuser' });
    expect(refuse.disabled).toBe(true);
    await user.click(refuse);
    await user.type(screen.getByRole('textbox', { name: /motif/i }), '   ');

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refuser' }).disabled).toBe(true);
    expect(onDecideDelivery).not.toHaveBeenCalled();
  });

  it('Given a reason, When Refuser is clicked, Then the delivery is refused on the head shown, with the reason', async () => {
    const { onDecideDelivery, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));

    await user.type(screen.getByRole('textbox', { name: /motif/i }), 'Le cas vide manque.');
    await user.click(screen.getByRole('button', { name: 'Refuser' }));

    expect(onDecideDelivery).toHaveBeenCalledExactlyOnceWith(
      'd1',
      'refuse',
      HEAD,
      'Le cas vide manque.',
    );
  });

  it('Given a reason written by someone with markup, When the item is shown, Then nothing of it is rendered as an element', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Refuser' }));

    await user.type(
      screen.getByRole('textbox', { name: /motif/i }),
      '<img src=x onerror=alert(1)>',
    );

    expect(document.querySelector('img')).toBeNull();
  });

  it('Given no handler, When Valider is clicked, Then nothing breaks', async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <TodoItem
          todo={
            {
              id: 'd1:delivery-review',
              agentId: dev.id,
              kind: 'delivery-review',
              title: '◎ Relire la PR #7 · 0012-connexion · abcdef0',
              actions: [],
              delivery: { id: 'd1', head: HEAD, url: PR_URL, verdict: 'accepted' },
            } as never
          }
          agent={dev}
        />
      </ul>,
    );

    await user.click(screen.getByRole('button', { name: 'Valider' }));

    expect(screen.getByRole('listitem')).toBeTruthy();
  });
});
