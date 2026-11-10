import { describe, expect, it } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent, FreeTerminal, Workspace } from '../../../src/shared/model';
import type { UsageState } from '../../../src/shared/usage';

// T080 — the À faire items, derived from the agents only (data-model TodoItem, FR-027, FR-028).

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: `a${String(n)}`,
  workspaceId: 'w1',
  position: n,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(n)}`,
  worktreePath: `/w/.worktrees/claude-code-${String(n)}`,
  port: 3000 + n,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'working',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
  ...overrides,
});

const shell = (id: string, path: string): FreeTerminal => ({
  id,
  workspaceId: 'w1',
  cwd: '/w',
  shell: path,
});

const workspace = (agents: Agent[], freeTerminals: FreeTerminal[] = []) =>
  ({ agents, freeTerminals, mainBranch: 'main' }) satisfies Pick<
    Workspace,
    'agents' | 'freeTerminals' | 'mainBranch'
  >;

const names = (id: string) => ({ 'claude-code': 'Claude Code', codex: 'Codex' })[id] ?? id;

const rateLimited = { code: 1, kind: 'rate-limit' as const, message: 'Limite atteinte' };

describe('deriveTodos', () => {
  it('asks to answer first, then rate limits, then prompts, then free terminals', () => {
    const todos = deriveTodos(
      workspace(
        [
          agent(1, { state: 'awaiting-prompt' }),
          agent(2, { state: 'error', lastError: rateLimited }),
          agent(3, { state: 'awaiting-answer' }),
          agent(4, { state: 'awaiting-answer' }),
        ],
        [shell('t1', '/bin/zsh')],
      ),
      names,
    );
    expect(todos.map((t) => t.id)).toEqual([
      'a3:answer',
      'a4:answer',
      'a2:rate-limit',
      'a1:prompt',
      't1:info',
    ]);
  });

  it('keeps the tile order within a kind, whatever the order of the agents', () => {
    const todos = deriveTodos(
      workspace([agent(2, { state: 'awaiting-answer' }), agent(1, { state: 'awaiting-answer' })]),
      names,
    );
    expect(todos.map((t) => t.agentId)).toEqual(['a1', 'a2']);
  });

  it('sends a question to the terminal instead of offering Autoriser / Refuser (T162)', () => {
    const [todo] = deriveTodos(
      workspace([agent(1, { state: 'awaiting-answer', awaiting: 'question' })]),
      names,
    );
    expect(todo).toMatchObject({ kind: 'answer', title: '◆ Répondre', actions: ['open-terminal'] });
  });

  it('offers the same actions as the tile (FR-028)', () => {
    const [answer, limit] = deriveTodos(
      workspace([
        agent(1, { state: 'awaiting-answer' }),
        agent(2, { state: 'error', lastError: rateLimited }),
      ]),
      names,
    );
    expect(answer).toMatchObject({
      kind: 'answer',
      title: '◆ Répondre',
      actions: ['allow', 'deny'],
    });
    expect(limit).toMatchObject({
      kind: 'rate-limit',
      title: '✕ Limite de débit · Claude Code',
      actions: ['log', 'restart', 'resume'],
    });
  });

  it('asks for a prompt for each agent waiting for one, naming its CLI', () => {
    const [todo] = deriveTodos(
      workspace([agent(1, { state: 'awaiting-prompt', cliId: 'codex' })]),
      names,
    );
    expect(todo).toEqual({
      id: 'a1:prompt',
      agentId: 'a1',
      kind: 'prompt',
      title: 'Donner une consigne · Codex · tapez dans le terminal',
      actions: [],
    });
  });

  it('shows each free terminal as running on the main branch', () => {
    const todos = deriveTodos(
      workspace(
        [],
        [shell('t1', '/bin/zsh'), shell('t2', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')],
      ),
      names,
    );
    expect(todos.map((t) => t.title)).toEqual(['En cours ▸ zsh — main', 'En cours ▸ pwsh — main']);
    expect(todos[0]).toMatchObject({ kind: 'info', agentId: 't1', actions: [] });
  });

  it('lists nothing for agents that are starting, working, done, closed or crashed', () => {
    const states = ['starting', 'working', 'done', 'closed'] as const;
    const agents = states.map((state, i) => agent(i + 1, { state }));
    agents.push(
      agent(9, {
        state: 'error',
        lastError: { code: 1, kind: 'crash', message: 'Le processus s’est arrêté (code 1).' },
      }),
    );
    expect(deriveTodos(workspace(agents), names)).toEqual([]);
  });

  it('offers « Revue → » for an agent done with changes to review, before prompts (FR-002)', () => {
    const todos = deriveTodos(
      workspace([
        agent(1, { state: 'awaiting-prompt' }),
        agent(2, { state: 'done', cliId: 'codex' }),
        agent(3, { state: 'awaiting-prompt' }),
        agent(4, { state: 'awaiting-answer' }),
      ]),
      names,
      { a2: 3, a3: 1 },
    );
    expect(todos.map((t) => t.id)).toEqual(['a4:answer', 'a2:review', 'a3:review', 'a1:prompt']);
    expect(todos[1]).toEqual({
      id: 'a2:review',
      agentId: 'a2',
      kind: 'review',
      title: 'Changements à relire · Codex 2 · 3 fichiers',
      actions: ['review'],
    });
  });

  it('keeps answers and rate limits first, even for an agent to review', () => {
    const todos = deriveTodos(workspace([agent(1, { state: 'awaiting-answer' })]), names, {
      a1: 2,
    });
    expect(todos.map((t) => t.id)).toEqual(['a1:answer']);
  });

  it('asks to merge what a local delivery proposes, after answers and before reviews', () => {
    const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
    const request = {
      id: 'r1',
      agentId: 'a2',
      channel: 'local',
      state: 'reviewing',
      unverified: false,
      frozenCommit: HEAD,
      title: 'Connexion',
      message: 'feat: connexion',
    };
    const todos = deriveTodos(
      {
        ...workspace([
          agent(1, { state: 'done' }),
          agent(2, { state: 'done' }),
          agent(3, { state: 'awaiting-answer' }),
        ]),
        // A request for an agent already gone gives nothing.
        deliveries: [request, { ...request, id: 'r2', agentId: 'a9' }] as never,
      },
      names,
      { a1: 1 },
    );
    expect(todos.map((t) => t.id)).toEqual(['a3:answer', 'r1:delivery-local', 'a1:review']);
    expect(todos[1]).toMatchObject({
      agentId: 'a2',
      kind: 'delivery-local',
      title: '◎ Fusionner Claude Code 2 → main ?',
      delivery: { id: 'r1', head: HEAD },
    });
  });

  // 004 T022 — « ✕ Boucle arrêtée »: after the integrations asked for, before the reviews.
  it('asks the user to decide on a loop stopped after 3 rounds (FR-018)', () => {
    const loop = (issueId: string, state: 'running' | 'escalated', devAgentId = 'a2') => ({
      issueId,
      devAgentId,
      testAgentId: 'a3',
      round: 3,
      rounds: [],
      state,
      escalatedModel: null,
      polish: null,
    });
    const todos = deriveTodos(
      {
        ...workspace([
          agent(1, { state: 'done' }),
          agent(2, { state: 'done' }),
          agent(3, { state: 'awaiting-answer' }),
        ]),
        loops: [
          loop('0012-connexion', 'escalated'),
          loop('0013-panier', 'running'),
          // A loop whose dev is gone gives nothing.
          loop('0014-paiement', 'escalated', 'a9'),
        ],
      },
      names,
      { a1: 1 },
    );
    expect(todos.map((t) => t.id)).toEqual([
      'a3:answer',
      '0012-connexion:loop-escalated',
      'a1:review',
    ]);
    expect(todos.find((t) => t.kind === 'loop-escalated')).toMatchObject({
      agentId: 'a2',
      title: '✕ Boucle arrêtée · 0012-connexion · 3 tours',
      loop: { issueId: '0012-connexion' },
    });
  });

  // 008 T056 / US5 sc.7 — the title of a loop stopped and its « Relancer » name the ceiling of the PROJECT.
  //
  // RED until T059. Assumed API: `deriveTodos` reads `workspace.delivery.maxRounds` (3 when the workspace has no
  // `delivery`, as the test above); the title is « ✕ Boucle arrêtée · <issue> · <N> tours » and the item carries
  // `loop: { issueId, maxRounds: N }`, from which TodoItem.tsx writes « Relancer N tours ».
  describe('a loop stopped under the ceiling of the project (008 US5 sc.7)', () => {
    const stopped = {
      issueId: '0012-connexion',
      devAgentId: 'a2',
      testAgentId: 'a3',
      round: 5,
      rounds: [],
      state: 'escalated' as const,
      escalatedModel: null,
      polish: null,
    };
    const derive = (maxRounds: number | null) =>
      deriveTodos(
        {
          ...workspace([agent(2, { state: 'done' }), agent(3, { state: 'done' })]),
          loops: [stopped],
          ...(maxRounds === null
            ? {}
            : {
                delivery: {
                  auto: false,
                  mergeMode: 'squash' as const,
                  maxRounds,
                  polishPasses: 0,
                  polishBrief: '',
                },
              }),
        },
        names,
        {},
      ).find((t) => t.kind === 'loop-escalated');

    it('Given a ceiling of 5 in the project, When a loop is stopped, Then the title says 5 tours and the item carries the ceiling for « Relancer 5 tours »', () => {
      expect(derive(5)).toMatchObject({
        title: '✕ Boucle arrêtée · 0012-connexion · 5 tours',
        loop: { issueId: '0012-connexion', maxRounds: 5 },
      });
    });

    it('Given a ceiling of 10, When a loop is stopped, Then the title says 10 tours', () => {
      expect(derive(10)).toMatchObject({
        title: '✕ Boucle arrêtée · 0012-connexion · 10 tours',
        loop: { maxRounds: 10 },
      });
    });

    it('Given the default ceiling of 3, When a loop is stopped, Then the title still says 3 tours: the value is the project’s', () => {
      expect(derive(3)).toMatchObject({
        title: '✕ Boucle arrêtée · 0012-connexion · 3 tours',
        loop: { maxRounds: 3 },
      });
    });

    it('Given a workspace without settings (an old state), When a loop is stopped, Then the ceiling is the default 3', () => {
      expect(derive(null)).toMatchObject({
        title: '✕ Boucle arrêtée · 0012-connexion · 3 tours',
        loop: { maxRounds: 3 },
      });
    });
  });

  // fix-relance-communs — two agents changing the same files give no « Fichiers communs » entry:
  // the reviews alone are listed (the overlaps are no input of the todos any more).
  it('lists no « Fichiers communs » entry for agents that change the same files', () => {
    const todos = deriveTodos(
      workspace([agent(1, { state: 'done' }), agent(2, { state: 'done' })]),
      names,
      { a1: 1, a2: 1 },
    );
    expect(todos.map((t) => t.id)).toEqual(['a1:review', 'a2:review']);
    expect(todos.some((t) => (t.kind as string) === 'overlap')).toBe(false);
    expect(todos.some((t) => t.title.includes('Fichiers communs'))).toBe(false);
  });

  // 004 T029 — « ◎ Créer N issues ? »: the orchestrator asks, the user decides (FR-023).
  it('asks the user to publish the issues of the orchestrator, after the integrations', () => {
    const issue = (id: string, title: string) => ({
      id,
      title,
      path: `.pact/issues/${id}.md`,
      state: 'ready' as const,
      remote: null,
      trace: { branch: null, agents: [], pr: null },
    });
    const request = (id: string, issueIds: string[]) => ({
      id,
      issueIds,
      requestedAt: '2026-11-03T10:00:00.000Z',
    });
    const lead = agent(1, { state: 'working', role: 'orchestrator' });
    const todos = deriveTodos(
      {
        ...workspace([lead, agent(2, { state: 'awaiting-answer' })]),
        issues: [issue('0012-connexion', 'Connexion'), issue('0013-export', 'Export CSV')],
        // An issue no longer known is named by its id.
        publishRequests: [request('r1', ['0012-connexion', '0013-export', '0099'])],
      },
      names,
    );
    expect(todos.map((t) => t.id)).toEqual(['a2:answer', 'r1:publish-issues']);
    expect(todos[1]).toEqual({
      id: 'r1:publish-issues',
      agentId: 'a1',
      kind: 'publish-issues',
      title: '◎ Créer 3 issues ? · Claude Code 1 · Connexion, Export CSV, 0099',
      actions: [],
      publish: { requestId: 'r1' },
    });

    const one = deriveTodos(
      { ...workspace([lead]), publishRequests: [request('r2', ['0012-connexion'])] },
      names,
    );
    expect(one[0]?.title).toBe('◎ Créer 1 issue ? · Claude Code 1 · 0012-connexion');
    expect(deriveTodos(workspace([lead]), names)).toEqual([]);
    // Without an orchestrator, nobody asks.
    expect(
      deriveTodos(
        { ...workspace([agent(1)]), publishRequests: [request('r3', ['0012-connexion'])] },
        names,
      ),
    ).toEqual([]);
  });
});

// 005 T019 — « ◆ Limite <CLI> à <N> % · <fenêtre> · réinitialisation <heure> » (FR-011).
describe('usage alerts', () => {
  const NOW = new Date('2026-11-03T14:00:00');
  const reset = new Date('2026-11-03T16:40:00').toISOString();
  const usageState = (percent: number, over: Partial<UsageState> = {}): UsageState => ({
    cliId: 'claude-code',
    account: 'default',
    reading: {
      cliId: 'claude-code',
      account: 'default',
      readAt: NOW.toISOString(),
      windows: [
        { id: 'five-hour', label: '5 h', usedPercent: percent, resetsAt: reset, minutes: 300 },
      ],
    },
    shares: [],
    level: 'ok',
    ...over,
  });
  const alerts = (states: UsageState[], now = NOW, thresholds = { warn: 80, critical: 95 }) =>
    deriveTodos(workspace([agent(1)]), () => 'Claude Code', [], {
      states,
      thresholds,
      now,
    }).filter((todo) => todo.kind === 'usage-limit');

  it('tells the CLI, the percentage, the window and the reset time, one per account', () => {
    const [alert, ...rest] = alerts([usageState(85)]);
    expect(rest).toEqual([]);
    expect(alert).toEqual({
      id: 'usage:claude-code:default:usage-limit',
      agentId: 'usage:claude-code:default',
      kind: 'usage-limit',
      title: '◆ Limite Claude Code à 85 % · 5 h · réinitialisation 16:40',
      actions: [],
      usage: { cliId: 'claude-code', account: 'default', level: 'warn' },
    });
  });

  it('keeps the same item from 80 to 95 %, red at 95, gone below 80 or once reset', () => {
    expect(alerts([usageState(79)])).toEqual([]);
    expect(alerts([usageState(80)]).map((t) => t.id)).toEqual(
      alerts([usageState(97)]).map((t) => t.id),
    );
    expect(alerts([usageState(97)])[0]?.usage?.level).toBe('critical');
    expect(alerts([usageState(97)], new Date('2026-11-03T16:41:00'))).toEqual([]);
    expect(alerts([usageState(85)], NOW, { warn: 90, critical: 95 })).toEqual([]);
  });

  it('says the reset is unknown when the CLI does not tell it', () => {
    const unknown = usageState(85);
    const [window] = unknown.reading?.windows ?? [];
    if (!unknown.reading || !window) throw new Error('no window');
    unknown.reading.windows = [{ ...window, resetsAt: null }];
    expect(alerts([unknown])[0]?.title).toBe(
      '◆ Limite Claude Code à 85 % · 5 h · réinitialisation inconnue',
    );
  });

  it('only for the CLIs of the workspace, after the rate limits and before the reviews', () => {
    expect(alerts([usageState(85, { cliId: 'codex' })])).toEqual([]);
    const todos = deriveTodos(
      workspace([agent(1, { state: 'awaiting-prompt' })]),
      () => 'Claude Code',
      { a1: 1 },
      { states: [usageState(85)], thresholds: { warn: 80, critical: 95 }, now: NOW },
    );
    expect(todos.map((t) => t.kind)).toEqual(['usage-limit', 'review']);
  });
});

// fix-todo-diff-notifications — hypotheses of interface (see the report of the test agent):
// - `toReview` is `Record<agentId, number of changed files>`;
// - a report is kept on the agent as `lastReport: { status, questions }`, whichever its loop.
type WithReport = Partial<Agent> & {
  lastReport?: { status: 'done' | 'blocked' | 'defects'; questions: string[] } | null;
};
const reported = (n: number, overrides: WithReport = {}): Agent => agent(n, overrides);

const loopOf = (
  state: 'running' | 'escalated' | 'polishing' | 'accepted' | 'delivering' | 'merged' | 'closed',
  devAgentId: string,
  testAgentId: string,
) => ({
  issueId: '0020-panier',
  devAgentId,
  testAgentId,
  round: 1,
  rounds: [],
  state,
  escalatedModel: null,
  polish: null,
});

describe('deriveTodos — « Changements à relire » names the agent, its role and its size', () => {
  it('gives the number, the role and the files of an agent outside a loop', () => {
    const todos = deriveTodos(workspace([agent(4, { state: 'done', role: 'spec' })]), names, {
      a4: 8,
    });
    expect(todos[0]).toMatchObject({
      id: 'a4:review',
      kind: 'review',
      title: 'Changements à relire · Claude Code 4 · spec · 8 fichiers',
    });
  });

  it('says « 1 fichier » in the singular, and leaves the role out when there is none', () => {
    const [todo] = deriveTodos(workspace([agent(2, { state: 'awaiting-prompt' })]), names, {
      a2: 1,
    });
    expect(todo?.title).toBe('Changements à relire · Claude Code 2 · 1 fichier');
  });
});

describe('deriveTodos — who has no review', () => {
  it('never lists the orchestrator to review, whatever it changed', () => {
    const todos = deriveTodos(
      workspace([agent(1, { state: 'done', role: 'orchestrator' })]),
      names,
      { a1: 5 },
    );
    expect(todos.filter((t) => t.kind === 'review')).toEqual([]);
  });

  it.each(['running', 'escalated', 'polishing', 'delivering'] as const)(
    'gives the dev of a %s loop no review',
    (state) => {
      const todos = deriveTodos(
        {
          ...workspace([
            agent(1, { state: 'done', role: 'dev' }),
            agent(2, { state: 'done', role: 'test' }),
          ]),
          loops: [loopOf(state, 'a1', 'a2')],
        },
        names,
        { a1: 2, a2: 1 },
      );
      expect(todos.filter((t) => t.kind === 'review')).toEqual([]);
    },
  );

  it.each(['accepted', 'merged', 'closed'] as const)(
    'gives the dev of a %s loop its review',
    (state) => {
      const todos = deriveTodos(
        {
          ...workspace([agent(1, { state: 'done', role: 'dev' })]),
          loops: [loopOf(state, 'a1', 'a2')],
        },
        names,
        { a1: 2 },
      );
      expect(todos.map((t) => t.id)).toEqual(['a1:review']);
    },
  );

  it.each([
    'running',
    'escalated',
    'polishing',
    'accepted',
    'delivering',
    'merged',
    'closed',
  ] as const)('gives the tester of a %s loop no review', (state) => {
    const todos = deriveTodos(
      {
        ...workspace([
          agent(1, { state: 'working', role: 'dev' }),
          agent(2, { state: 'done', role: 'test' }),
        ]),
        loops: [loopOf(state, 'a1', 'a2')],
      },
      names,
      { a2: 3 },
    );
    expect(todos.filter((t) => t.id === 'a2:review')).toEqual([]);
  });
});

describe('deriveTodos — « ◆ Décider »: an agent stopped with questions', () => {
  const blocked = (n: number, count: number, overrides: WithReport = {}) =>
    reported(n, {
      state: 'done',
      role: 'spec',
      lastReport: {
        status: 'blocked',
        questions: Array.from({ length: count }, (_, i) => `Question ${String(i + 1)} ?`),
      },
      ...overrides,
    });

  it('names the agent, its role and the number of questions', () => {
    const [todo] = deriveTodos(workspace([blocked(4, 2)]), names);
    expect(todo).toMatchObject({
      id: 'a4:decide',
      agentId: 'a4',
      kind: 'decide',
      title: '◆ Décider · Claude Code 4 · spec · 2 questions',
    });
  });

  it('says « 1 question » in the singular and leaves the role out when there is none', () => {
    const [todo] = deriveTodos(
      workspace([blocked(2, 1, { role: null, state: 'awaiting-prompt' })]),
      names,
    );
    expect(todo?.title).toBe('◆ Décider · Claude Code 2 · 1 question');
  });

  it('comes after « Répondre » and before the others, in place of the review and the prompt', () => {
    const todos = deriveTodos(
      {
        ...workspace([
          agent(1, { state: 'awaiting-prompt' }),
          blocked(2, 3),
          agent(3, { state: 'awaiting-answer' }),
          agent(4, { state: 'error', lastError: rateLimited }),
          blocked(5, 1, { state: 'awaiting-prompt' }),
        ]),
        deliveries: [
          {
            id: 'r1',
            agentId: 'a1',
            channel: 'local',
            state: 'reviewing',
            unverified: false,
            frozenCommit: 'abcdef0123456789abcdef0123456789abcdef01',
            title: 'Connexion',
            message: 'feat',
          },
        ] as never,
      },
      names,
      { a1: 1, a2: 4, a5: 2 },
    );
    expect(todos.map((t) => t.id)).toEqual([
      'a3:answer',
      'a2:decide',
      'a5:decide',
      'r1:delivery-local',
      'a4:rate-limit',
      'a1:review',
    ]);
  });

  it('applies with a loop too, where the agent is the dev or the tester', () => {
    const todos = deriveTodos(
      {
        ...workspace([blocked(1, 1, { role: 'dev' }), blocked(2, 2, { role: 'test' })]),
        loops: [loopOf('running', 'a1', 'a2')],
      },
      names,
    );
    expect(todos.map((t) => t.id)).toEqual(['a1:decide', 'a2:decide']);
  });

  it('disappears when the agent works again', () => {
    for (const state of ['working', 'starting'] as const) {
      expect(deriveTodos(workspace([blocked(1, 2, { state })]), names)).toEqual([]);
    }
  });

  it('disappears when a new report arrives, with no more questions', () => {
    const next = blocked(1, 0, {
      lastReport: { status: 'done', questions: [] },
    });
    expect(deriveTodos(workspace([next]), names, { a1: 2 }).map((t) => t.kind)).toEqual(['review']);
  });

  it('is not asked for a report that is not « blocked »', () => {
    const done = reported(1, { state: 'done', lastReport: { status: 'done', questions: [] } });
    expect(deriveTodos(workspace([done]), names)).toEqual([]);
  });
});

// 007 T021 — « ◆ Réveil en attente » (data-model « TodoKind », contracts/ui.md): a wake held back and
// said by `Agent.wakeNotice`, derived and never stored, one item on the line of its agent. API fixed
// for the dev: `TodoItem.detail?: string`, the sentence under the title.
describe('wake-held (007)', () => {
  const held = (items: ReturnType<typeof deriveTodos>) =>
    items.filter((item) => item.kind === 'wake-held');

  it('Given a held wake because of the prompt, When todos are derived, Then « saisie en cours » with its sentence and « Répondre dans le terminal ↗ »', () => {
    const items = deriveTodos(workspace([agent(1, { state: 'done', wakeNotice: 'input' })]), names);
    expect(held(items)).toEqual([
      {
        id: 'a1:wake-held',
        agentId: 'a1',
        kind: 'wake-held',
        title: '◆ Réveil en attente · Claude Code 1 · saisie en cours',
        actions: ['open-terminal'],
        detail: expect.stringMatching(/^Videz l['’]invite ou envoyez votre saisie\.$/) as string,
      },
    ]);
  });

  it('Given a held wake because of the cap, When todos are derived, Then « plafond atteint », its sentence and no action', () => {
    const items = deriveTodos(workspace([agent(2, { state: 'done', wakeNotice: 'cap' })]), names);
    expect(held(items)).toEqual([
      {
        id: 'a2:wake-held',
        agentId: 'a2',
        kind: 'wake-held',
        title: '◆ Réveil en attente · Claude Code 2 · plafond atteint',
        actions: [],
        detail: '20 réveils cette heure : les événements restent lisibles.',
      },
    ]);
  });

  it.each([null, undefined])(
    'Given a wake notice of %s, When todos are derived, Then there is no item',
    (notice) => {
      const items = deriveTodos(
        workspace([agent(1, { state: 'done', ...(notice === null ? { wakeNotice: null } : {}) })]),
        names,
      );
      expect(held(items)).toEqual([]);
    },
  );

  it('Given an agent that waits for a prompt and holds a wake, When todos are derived, Then both its items are there', () => {
    const items = deriveTodos(
      workspace([agent(1, { state: 'awaiting-prompt', wakeNotice: 'input' })]),
      names,
    );
    expect(items.map((item) => item.kind)).toEqual(['wake-held', 'prompt']);
  });

  it('Given a role, When the agent holds a wake, Then the title names the agent as the other items do', () => {
    const items = deriveTodos(
      workspace([agent(3, { state: 'done', role: 'orchestrator', wakeNotice: 'input' })]),
      names,
    );
    expect(held(items)[0]?.title).toMatch(
      /^◆ Réveil en attente · Claude Code 3( · orchestrator)? · saisie en cours$/,
    );
  });

  it('Given several kinds, When todos are derived, Then wake-held comes after the answers and the limits, before the reviews and the prompts', () => {
    const items = deriveTodos(
      workspace([
        agent(1, { state: 'awaiting-prompt' }),
        agent(2, { state: 'done', wakeNotice: 'cap' }),
        agent(3, { state: 'done' }),
        agent(4, { state: 'awaiting-answer' }),
        agent(5, { state: 'error', lastError: rateLimited }),
      ]),
      names,
      { a3: 2 },
    );
    expect(items.map((item) => item.kind)).toEqual([
      'answer',
      'rate-limit',
      'wake-held',
      'review',
      'prompt',
    ]);
  });

  it('Given a closed agent, When it still carries a notice, Then it shows nothing', () => {
    const items = deriveTodos(
      workspace([agent(1, { state: 'closed', wakeNotice: 'input' })]),
      names,
    );
    expect(held(items)).toEqual([]);
  });
});

// 007 T042 — the route of the questions (FR-029 to FR-031, US3 sc.13 to 15, data-model « Changement
// de decide », research R9) and « ✕ Échanges en boucle » (FR-006, contracts/ui.md).
//
// API fixed here for the dev (see the report, « API fixées »):
//   deriveTodos reads `workspace.exchanges` (optional, like `loops`);
//   a pending escalation of two agents still in the workspace gives
//     { id: '<escalationId>:exchange-escalated', agentId: <first agent of the pair, by position>,
//       kind: 'exchange-escalated', actions: [],
//       title: '✕ Échanges en boucle · <CLI> <n> ↔ <CLI> <m> · 3 allers-retours',
//       exchange: { escalationId, text: <text of the last message, or ''> } }
//   (`TodoItem.exchange` is new). A `cut` escalation, or one with an agent gone, gives nothing.
describe('deriveTodos — the questions go to the orchestrator first (FR-029 to FR-031)', () => {
  const asking = (n: number, overrides: WithReport = {}) =>
    reported(n, {
      state: 'done',
      role: 'dev',
      lastReport: { status: 'blocked', questions: ['Quelle base ?', 'Quel nom ?'] },
      ...overrides,
    });
  const lead = (overrides: Partial<Agent> = {}) =>
    agent(1, { role: 'orchestrator', state: 'working', ...overrides });
  const kinds = (todos: ReturnType<typeof deriveTodos>) => todos.map((t) => t.id);

  it('Given an orchestrator present and not in error, When an agent reports blocked with questions, Then no « ◆ Décider » for the user', () => {
    for (const state of ['working', 'awaiting-prompt', 'done'] as const) {
      const todos = deriveTodos(workspace([lead({ state }), asking(2)]), names);
      expect(todos.filter((t) => t.kind === 'decide')).toEqual([]);
    }
  });

  it('Given that route, When the agent is ready, Then the rest of its items applies: its review, or its prompt', () => {
    const review = deriveTodos(workspace([lead(), asking(2)]), names, { a2: 3 });
    expect(kinds(review)).toEqual(['a2:review']);
    const prompt = deriveTodos(workspace([lead(), asking(2, { state: 'awaiting-prompt' })]), names);
    expect(kinds(prompt)).toEqual(['a2:prompt']);
    const none = deriveTodos(workspace([lead(), asking(2)]), names);
    expect(none).toEqual([]);
  });

  it('Given an orchestrator, When the report is of a tester or comes from a loop, Then there is no « ◆ Décider » either', () => {
    const todos = deriveTodos(
      {
        ...workspace([lead(), asking(2, { role: 'dev' }), asking(3, { role: 'test' })]),
        loops: [loopOf('running', 'a2', 'a3')],
      },
      names,
    );
    expect(todos.filter((t) => t.kind === 'decide')).toEqual([]);
  });

  it('Given an orchestrator in error, When an agent reports blocked with questions, Then « ◆ Décider » stays', () => {
    const todos = deriveTodos(
      workspace([lead({ state: 'error', lastError: rateLimited }), asking(2)]),
      names,
    );
    expect(todos.find((t) => t.kind === 'decide')).toMatchObject({
      id: 'a2:decide',
      title: '◆ Décider · Claude Code 2 · dev · 2 questions',
      decide: { questions: ['Quelle base ?', 'Quel nom ?'] },
    });
  });

  it('Given an orchestrator in error, When it recovers, Then « ◆ Décider » goes away', () => {
    const failed = lead({ state: 'error', lastError: rateLimited });
    expect(kinds(deriveTodos(workspace([failed, asking(2)]), names))).toContain('a2:decide');
    expect(kinds(deriveTodos(workspace([lead(), asking(2)]), names))).not.toContain('a2:decide');
  });

  it('Given no orchestrator, When an agent reports blocked with questions, Then « ◆ Décider » is shown as before', () => {
    const todos = deriveTodos(workspace([asking(2), asking(3, { role: 'spec' })]), names);
    expect(todos.map((t) => t.id)).toEqual(['a2:decide', 'a3:decide']);
    expect(todos[1]?.title).toBe('◆ Décider · Claude Code 3 · spec · 2 questions');
  });

  it('Given an orchestrator, When the orchestrator itself reports blocked with questions, Then it keeps its own « ◆ Décider »', () => {
    const own = lead({
      state: 'done',
      lastReport: { status: 'blocked', questions: ['Je publie ?'] },
    });
    const todos = deriveTodos(workspace([own, asking(2)]), names);
    expect(kinds(todos)).toEqual(['a1:decide']);
    expect(todos[0]?.title).toBe('◆ Décider · Claude Code 1 · orchestrator · 1 question');
  });

  it.each([
    ['an orchestrator present', [agent(1, { role: 'orchestrator', state: 'working' })]],
    [
      'an orchestrator in error',
      [agent(1, { role: 'orchestrator', state: 'error', lastError: rateLimited })],
    ],
    ['no orchestrator', []],
  ])(
    'Given %s, When an agent waits for an answer in its terminal, Then « ◆ Répondre » is shown (FR-031)',
    (_name, others) => {
      const waiting = asking(2, { state: 'awaiting-answer', awaiting: 'question' });
      const todos = deriveTodos(workspace([...others, waiting]), names);
      expect(todos.filter((t) => t.agentId === 'a2')).toEqual([
        expect.objectContaining({
          id: 'a2:answer',
          kind: 'answer',
          title: '◆ Répondre',
          actions: ['open-terminal'],
        }),
      ]);
    },
  );

  it('Given an orchestrator, When an agent waits for an authorization, Then « ◆ Répondre » keeps Autoriser and Refuser', () => {
    const waiting = asking(2, { state: 'awaiting-answer' });
    const todos = deriveTodos(workspace([lead(), waiting]), names);
    expect(todos.find((t) => t.agentId === 'a2')).toMatchObject({
      kind: 'answer',
      actions: ['allow', 'deny'],
    });
  });

  it('Given an orchestrator that itself waits for an answer, When todos are derived, Then it has « ◆ Répondre »', () => {
    const todos = deriveTodos(
      workspace([lead({ state: 'awaiting-answer', awaiting: 'question' })]),
      names,
    );
    expect(kinds(todos)).toEqual(['a1:answer']);
  });
});

describe('deriveTodos — « ✕ Échanges en boucle » (FR-006)', () => {
  const at = '2026-11-08T10:00:00.000Z';
  const msg = (id: string, text: string) => ({
    id,
    at,
    from: 'a2',
    to: 'a3',
    type: 'action' as const,
    kind: 'message' as const,
    text,
    unreadBy: [],
  });
  const escalation = (
    state: 'pending' | 'cut' = 'pending',
    agents: [string, string] = ['a2', 'a3'],
  ) => ({
    id: 'e1',
    agents,
    lastMessageId: 'm9',
    state,
    at,
  });
  const withExchanges = (
    agents: Agent[],
    escalations: ReturnType<typeof escalation>[],
    messages = [msg('m9', 'Je ne suis pas d’accord, relis le contrat.')],
  ) => ({
    ...workspace(agents),
    exchanges: { messages, escalations },
  });
  const pair = () => [
    agent(2, { state: 'done', role: 'dev' }),
    agent(3, { state: 'done', role: 'spec' }),
  ];

  it('Given a pending escalation, When todos are derived, Then one item names the two agents, the round trips and carries the last message', () => {
    const todos = deriveTodos(withExchanges(pair(), [escalation()]), names);
    expect(todos).toEqual([
      {
        id: 'e1:exchange-escalated',
        agentId: 'a2',
        kind: 'exchange-escalated',
        title: '✕ Échanges en boucle · Claude Code 2 ↔ Claude Code 3 · 3 allers-retours',
        actions: [],
        exchange: { escalationId: 'e1', text: 'Je ne suis pas d’accord, relis le contrat.' },
      },
    ]);
  });

  it('Given a last message that is gone, When todos are derived, Then the item stays, with an empty text', () => {
    const todos = deriveTodos(withExchanges(pair(), [escalation()], []), names);
    expect(todos[0]).toMatchObject({ kind: 'exchange-escalated', exchange: { text: '' } });
  });

  it('Given an escalation cut by the user, When todos are derived, Then there is no item', () => {
    const todos = deriveTodos(withExchanges(pair(), [escalation('cut')]), names);
    expect(todos.filter((t) => t.kind === 'exchange-escalated')).toEqual([]);
  });

  it('Given one of the two agents gone, When todos are derived, Then there is no item', () => {
    const todos = deriveTodos(withExchanges([pair()[0] as Agent], [escalation()]), names);
    expect(todos.filter((t) => t.kind === 'exchange-escalated')).toEqual([]);
  });

  it('Given a workspace saved before 007, When todos are derived, Then there is no item and no error', () => {
    expect(deriveTodos(workspace(pair()), names)).toEqual([]);
  });

  it('Given a loop stopped and a limit, When todos are derived, Then the escalation comes right after the loop and before the limit and the reviews', () => {
    const todos = deriveTodos(
      {
        ...withExchanges(
          [
            ...pair(),
            agent(4, { state: 'error', lastError: rateLimited }),
            agent(5, { state: 'done' }),
          ],
          [escalation()],
        ),
        loops: [loopOf('escalated', 'a2', 'a3')],
      },
      names,
      { a5: 1 },
    );
    expect(todos.map((t) => t.kind)).toEqual([
      'loop-escalated',
      'exchange-escalated',
      'rate-limit',
      'review',
    ]);
  });

  it('Given an orchestrator in the pair, When todos are derived, Then the item names it like any agent', () => {
    const todos = deriveTodos(
      withExchanges(
        [
          agent(2, { state: 'done', role: 'orchestrator' }),
          agent(3, { state: 'done', role: 'dev' }),
        ],
        [escalation()],
      ),
      names,
    );
    expect(todos[0]?.title).toBe(
      '✕ Échanges en boucle · Claude Code 2 ↔ Claude Code 3 · 3 allers-retours',
    );
  });
});
