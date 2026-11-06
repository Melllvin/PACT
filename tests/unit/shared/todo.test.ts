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

  it('asks to integrate what the orchestrator proposes, after answers and before reviews', () => {
    const request = {
      id: 'r1',
      agentId: 'a2',
      mode: 'squash' as const,
      message: 'feat: connexion',
      requestedAt: '2026-11-03T00:00:00.000Z',
    };
    const todos = deriveTodos(
      {
        ...workspace([
          agent(1, { state: 'done' }),
          agent(2, { state: 'done' }),
          agent(3, { state: 'awaiting-answer' }),
        ]),
        // A request for an agent already gone gives nothing.
        integrationRequests: [request, { ...request, id: 'r2', agentId: 'a9' }],
      },
      names,
      { a1: 1 },
    );
    expect(todos.map((t) => t.id)).toEqual(['a3:answer', 'r1:integration-request', 'a1:review']);
    expect(todos[1]).toMatchObject({
      agentId: 'a2',
      kind: 'integration-request',
      title: '◎ Intégrer Claude Code 2 → main ?',
      request: { id: 'r1', message: 'feat: connexion' },
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
  state: 'running' | 'escalated' | 'passed' | 'closed',
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

  it.each(['running', 'escalated'] as const)('gives the dev of a %s loop no review', (state) => {
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
  });

  it.each(['passed', 'closed'] as const)('gives the dev of a %s loop its review', (state) => {
    const todos = deriveTodos(
      {
        ...workspace([agent(1, { state: 'done', role: 'dev' })]),
        loops: [loopOf(state, 'a1', 'a2')],
      },
      names,
      { a1: 2 },
    );
    expect(todos.map((t) => t.id)).toEqual(['a1:review']);
  });

  it.each(['running', 'escalated', 'passed', 'closed'] as const)(
    'gives the tester of a %s loop no review',
    (state) => {
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
    },
  );
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
        integrationRequests: [
          {
            id: 'r1',
            agentId: 'a1',
            mode: 'squash' as const,
            message: 'feat',
            requestedAt: '2026-11-03T00:00:00.000Z',
          },
        ],
      },
      names,
      { a1: 1, a2: 4, a5: 2 },
    );
    expect(todos.map((t) => t.id)).toEqual([
      'a3:answer',
      'a2:decide',
      'a5:decide',
      'r1:integration-request',
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
