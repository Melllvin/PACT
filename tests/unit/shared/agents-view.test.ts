import { describe, expect, it } from 'vitest';
import { agentPhase, agentRows, agentStateLabel } from '../../../src/shared/agents-view';
import {
  AGENT_COLORS,
  type Agent,
  type FreeTerminal,
  type Loop,
  type TodoItem,
  type Workspace,
} from '../../../src/shared/model';
import { defaultDeliverySettings } from '../../../src/shared/delivery';
import { deriveTodos } from '../../../src/shared/todo';
import { defaultWorkflow, type Run } from '../../../src/shared/workflow';

// 006 T004 and T005 — the state label and the phase of an agent, as the Agents column and the graph
// read them (data-model « AgentRow » and « Phase »).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = '2026-11-03T10:00:00.000Z';
const now = new Date(iso);

const agent = (position: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(position),
  workspaceId: 'w1',
  position,
  color: AGENT_COLORS[position - 1] ?? 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: `agent/claude-code-${String(position)}`,
  worktreePath: `/repo/.worktrees/claude-code-${String(position)}`,
  port: 3000 + position,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'starting',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  effort: null,
  launchedBy: null,
  closedWhileWorking: false,
  pause: null,
  ...overrides,
});

const loop = (overrides: Partial<Loop> = {}): Loop => ({
  issueId: '006-p12-base',
  devAgentId: uuid(2),
  testAgentId: uuid(3),
  round: 1,
  rounds: [],
  state: 'running',
  escalatedModel: null,
  polish: null,
  ...overrides,
});

describe('agentStateLabel', () => {
  it.each([
    ['starting', 'démarre'],
    ['working', 'travaille'],
    ['awaiting-prompt', 'attend une consigne'],
    ['awaiting-answer', 'attend une réponse'],
    ['done', 'fini'],
    ['error', 'erreur'],
    ['closed', 'fermé'],
  ] as const)('says « %s » → « %s »', (state, label) => {
    expect(agentStateLabel(agent(1, { state }), now)).toBe(label);
  });

  it('says « limite de débit » for a rate-limit error', () => {
    const limited = agent(1, {
      state: 'error',
      lastError: { code: null, kind: 'rate-limit', message: 'Rate limited' },
    });
    expect(agentStateLabel(limited, now)).toBe('limite de débit');
  });

  it('keeps « erreur » for a crash', () => {
    const crashed = agent(1, {
      state: 'error',
      lastError: { code: 1, kind: 'crash', message: 'boom' },
    });
    expect(agentStateLabel(crashed, now)).toBe('erreur');
  });

  it('says « reprise à HH:MM » (local time) when a resume is scheduled', () => {
    const at = new Date('2026-11-03T15:07:00.000Z');
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const waiting = agent(1, {
      state: 'error',
      lastError: { code: null, kind: 'rate-limit', message: 'Rate limited' },
      scheduledResume: { agentId: uuid(1), at: at.toISOString(), attempt: 0 },
    });
    expect(agentStateLabel(waiting, now)).toBe(`reprise à ${hhmm}`);
  });
});

describe('agentPhase', () => {
  it('reads a running loop as « dev ↔ test », its issue and its round out of 3', () => {
    const phase = agentPhase(agent(2), [loop({ round: 2 })]);
    expect(phase).toMatchObject({
      label: 'dev ↔ test',
      issueId: '006-p12-base',
      round: { n: 2, max: 3 },
    });
  });

  it('gives the same phase to the tester of the loop', () => {
    expect(agentPhase(agent(3), [loop()])).toMatchObject({
      label: 'dev ↔ test',
      issueId: '006-p12-base',
      round: { n: 1, max: 3 },
    });
  });

  it('reads a merged loop as « boucle terminée », without round', () => {
    const phase = agentPhase(agent(2), [loop({ state: 'merged' })]);
    expect(phase).toMatchObject({ label: 'boucle terminée', issueId: '006-p12-base' });
    expect(phase?.round).toBeUndefined();
  });

  it.each([
    ['accepted', 'boucle acceptée'],
    ['polishing', 'peaufinage'],
    ['delivering', 'en livraison'],
  ] as const)('reads a %s loop as « %s », without round (008 R12)', (state, label) => {
    const phase = agentPhase(agent(2), [loop({ state })]);
    expect(phase).toMatchObject({ label, issueId: '006-p12-base' });
    expect(phase?.round).toBeUndefined();
  });

  it('reads an escalated loop as « boucle arrêtée », without round', () => {
    const phase = agentPhase(agent(2), [loop({ state: 'escalated' })]);
    expect(phase).toMatchObject({ label: 'boucle arrêtée', issueId: '006-p12-base' });
    expect(phase?.round).toBeUndefined();
  });

  it('ignores a closed loop', () => {
    expect(agentPhase(agent(2), [loop({ state: 'closed' })])).toBeNull();
  });

  it('takes the most recent running loop among several', () => {
    const phase = agentPhase(agent(2), [
      loop({ issueId: 'a', state: 'running', round: 1 }),
      loop({ issueId: 'b', state: 'merged' }),
      loop({ issueId: 'c', state: 'running', round: 3 }),
      loop({ issueId: 'd', state: 'escalated' }),
    ]);
    expect(phase).toMatchObject({ label: 'dev ↔ test', issueId: 'c', round: { n: 3, max: 3 } });
  });

  it('takes the last loop of the array when none is running', () => {
    const phase = agentPhase(agent(2), [
      loop({ issueId: 'a', state: 'escalated' }),
      loop({ issueId: 'b', state: 'closed' }),
      loop({ issueId: 'c', state: 'merged' }),
    ]);
    expect(phase).toMatchObject({ label: 'boucle terminée', issueId: 'c' });
  });

  it('ignores the loops of other agents', () => {
    const other = loop({ devAgentId: uuid(4), testAgentId: uuid(5) });
    expect(agentPhase(agent(2), [other])).toBeNull();
  });

  it.each(['spec', 'design', 'recap'] as const)('reads the role « %s » out of a loop', (role) => {
    const phase = agentPhase(agent(4, { role }), []);
    expect(phase).toMatchObject({ label: role });
    expect(phase?.issueId ?? null).toBeNull();
    expect(phase?.round).toBeUndefined();
  });

  it('has no phase for an agent without role and out of a loop, nor for the orchestrator', () => {
    expect(agentPhase(agent(4), [])).toBeNull();
    expect(agentPhase(agent(1, { role: 'orchestrator' }), [])).toBeNull();
  });
});

// 006 T010 — `agentRows(workspace, todos)` (data-model « AgentsView »): one row per agent, the
// actions of `deriveTodos` grouped by agent and never recomputed (SC-005).

const names = (cliId: string) => (cliId === 'claude-code' ? 'Claude Code' : cliId);

const terminal: FreeTerminal = { id: 'term-1', workspaceId: 'w1', cwd: '/repo', shell: '/bin/zsh' };

const workspaceOf = (
  agents: Agent[],
  extra: Partial<Pick<Workspace, 'deliveries' | 'loops' | 'issues' | 'publishRequests'>> & {
    freeTerminals?: FreeTerminal[];
  } = {},
) => ({ agents, freeTerminals: [], mainBranch: 'main', loops: [], ...extra });

const todo = (
  agentId: string,
  kind: TodoItem['kind'],
  overrides: Partial<TodoItem> = {},
): TodoItem => ({
  id: `${agentId}:${kind}`,
  agentId,
  kind,
  title: kind,
  actions: [],
  ...overrides,
});

const view = (ws: ReturnType<typeof workspaceOf>, todos: TodoItem[]) =>
  agentRows(ws, todos, names, now);

describe('agentRows', () => {
  it('gives one row per agent, free terminals excluded, with name, role, state and issue', () => {
    const ws = workspaceOf(
      [agent(1, { role: 'orchestrator', state: 'working' }), agent(2, { state: 'working' })],
      { loops: [loop({ devAgentId: uuid(2), testAgentId: uuid(9) })], freeTerminals: [terminal] },
    );
    const result = view(ws, deriveTodos(ws, names));
    expect(result.agentCount).toBe(2);
    expect(result.rows.map((row) => row.agent.id)).toEqual([uuid(1), uuid(2)]);
    expect(result.rows[0]).toMatchObject({
      name: 'Claude Code 1',
      role: 'orchestrator',
      stateLabel: 'travaille',
      issueId: null,
      todo: null,
      pending: 0,
    });
    expect(result.rows[1]).toMatchObject({
      name: 'Claude Code 2',
      role: null,
      stateLabel: 'travaille',
      issueId: '006-p12-base',
    });
  });

  it.each([
    ['answer', { state: 'awaiting-answer' }],
    ['rate-limit', { state: 'error', lastError: { code: null, kind: 'rate-limit', message: 'x' } }],
    ['prompt', { state: 'awaiting-prompt' }],
  ] as const)('puts the « %s » item of an agent on its row, not in the head', (kind, state) => {
    const ws = workspaceOf([agent(1, state)]);
    const result = view(ws, deriveTodos(ws, names));
    expect(result.head).toEqual([]);
    expect(result.rows[0]?.todo?.kind).toBe(kind);
    expect(result.rows[0]?.pending).toBe(1);
  });

  it('puts the « review » item of an agent on its row', () => {
    const ws = workspaceOf([agent(1, { state: 'done' })]);
    const result = view(ws, deriveTodos(ws, names, { [uuid(1)]: 1 }));
    expect(result.head).toEqual([]);
    expect(result.rows[0]?.todo?.kind).toBe('review');
  });

  it('keeps the first item of the agent by ORDER as `todo`, and counts them all in `pending`', () => {
    const ws = workspaceOf([agent(1)]);
    const items = [todo(uuid(1), 'prompt'), todo(uuid(1), 'review'), todo(uuid(1), 'answer')];
    const row = view(ws, items).rows[0];
    expect(row?.todo?.kind).toBe('answer');
    expect(row?.pending).toBe(3);
  });

  it.each(['delivery-local', 'publish-issues', 'loop-escalated', 'usage-limit'] as const)(
    'sends « %s » to the head, even when it targets an agent',
    (kind) => {
      const ws = workspaceOf([agent(1)]);
      const item = todo(uuid(1), kind);
      const result = view(ws, [item]);
      expect(result.head).toEqual([item]);
      expect(result.rows[0]?.todo).toBeNull();
      expect(result.rows[0]?.pending).toBe(0);
    },
  );

  it('sends the free terminals (« info ») to the head', () => {
    const ws = workspaceOf([agent(1)], { freeTerminals: [terminal] });
    const result = view(ws, deriveTodos(ws, names));
    expect(result.head.map((item) => item.kind)).toEqual(['info']);
    expect(result.rows).toHaveLength(1);
  });

  it('orders the rows: with an action (ORDER, then position), then the orchestrator, then position', () => {
    const ws = workspaceOf([
      agent(1, { role: 'orchestrator', state: 'working' }),
      agent(2, { state: 'working' }),
      agent(3, { state: 'awaiting-prompt' }),
      agent(4, { state: 'awaiting-answer' }),
      agent(5, { state: 'awaiting-answer' }),
      agent(6, { state: 'working' }),
    ]);
    const result = view(ws, deriveTodos(ws, names));
    expect(result.rows.map((row) => row.agent.position)).toEqual([4, 5, 3, 1, 2, 6]);
  });

  it('counts the items that wait on the user, « info » excluded (unchanged counter)', () => {
    const ws = workspaceOf([agent(1, { state: 'awaiting-answer' }), agent(2)], {
      freeTerminals: [terminal],
    });
    const items = [...deriveTodos(ws, names), todo(uuid(2), 'usage-limit')];
    const result = view(ws, items);
    expect(items.map((item) => item.kind)).toContain('info');
    expect(result.pendingCount).toBe(2);
    expect(result.agentCount).toBe(2);
  });

  it('loses no item of deriveTodos: each one is in the head or on a row (SC-005)', () => {
    const ws = workspaceOf(
      [
        agent(1, { role: 'orchestrator', state: 'working' }),
        agent(2, { state: 'awaiting-answer' }),
        agent(3, { state: 'done' }),
      ],
      {
        freeTerminals: [terminal],
        deliveries: [
          {
            id: uuid(50),
            agentId: uuid(3),
            channel: 'local',
            state: 'reviewing',
            unverified: false,
            frozenCommit: 'abcdef0123456789abcdef0123456789abcdef01',
            title: 'x',
            message: 'feat: x',
          } as never,
        ],
      },
    );
    const items = deriveTodos(ws, names, { [uuid(3)]: 1 });
    const result = view(ws, items);
    const placed = result.rows.reduce((sum, row) => sum + row.pending, result.head.length);
    expect(placed).toBe(items.length);
    expect(result.head.map((item) => item.kind).sort()).toEqual(['delivery-local', 'info']);
  });
});

// 007 T021 — « ◆ Réveil en attente » goes on the line of its agent (data-model « TodoKind »,
// contracts/ui.md « Ligne de l'agent »), not in the head.
describe('agentRows — wake-held (007)', () => {
  it.each(['input', 'cap'] as const)(
    'Given a wake held for « %s », When the column is built, Then the item is on the row of its agent and not in the head',
    (notice) => {
      const ws = workspaceOf([agent(1, { state: 'done', wakeNotice: notice })]);
      const items = deriveTodos(ws, names);
      const result = view(ws, items);
      expect(items.map((item) => item.kind)).toEqual(['wake-held']);
      expect(result.head).toEqual([]);
      expect(result.rows[0]?.todo?.kind).toBe('wake-held');
      expect(result.rows[0]?.pending).toBe(1);
      expect(result.pendingCount).toBe(1);
    },
  );

  it('Given a held wake on a working agent, When the column is built, Then its row comes before the rows without action', () => {
    const ws = workspaceOf([
      agent(1, { role: 'orchestrator', state: 'working' }),
      agent(2, { state: 'working' }),
      agent(3, { state: 'done', wakeNotice: 'input' }),
    ]);
    const result = view(ws, deriveTodos(ws, names));
    expect(result.rows.map((row) => row.agent.position)).toEqual([3, 1, 2]);
  });

  it('Given an agent that waits for a prompt and holds a wake, When the column is built, Then the row shows the wake first and counts both', () => {
    const ws = workspaceOf([agent(1, { state: 'awaiting-prompt', wakeNotice: 'input' })]);
    const row = view(ws, deriveTodos(ws, names)).rows[0];
    expect(row?.todo?.kind).toBe('wake-held');
    expect(row?.pending).toBe(2);
  });

  it('Given a held wake, When the column is built, Then no item of deriveTodos is lost (SC-005)', () => {
    const ws = workspaceOf([
      agent(1, { state: 'done', wakeNotice: 'cap' }),
      agent(2, { state: 'awaiting-prompt', wakeNotice: 'input' }),
    ]);
    const items = deriveTodos(ws, names);
    const result = view(ws, items);
    const placed = result.rows.reduce((sum, row) => sum + row.pending, result.head.length);
    expect(placed).toBe(items.length);
  });
});

// 009 T005 — the label of a paused agent (contracts/ui.md « Tuile et ligne d'agent », SC-003).

describe('agentStateLabel of a paused agent', () => {
  const resumeAt = '2026-11-03T15:07:00.000Z';
  const hhmm = (() => {
    const at = new Date(resumeAt);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  })();
  const pause = (over: Record<string, unknown> = {}) => ({
    cliId: 'claude-code',
    account: 'default',
    cause: 'threshold',
    windows: [{ id: 'week', label: 'semaine', percent: 91, resetsAt: resumeAt }],
    resumeAt,
    pausedAt: iso,
    midTurn: true,
    saved: true,
    closedQuestion: null,
    blocked: null,
    ...over,
  });
  const paused = (pauseOver: Record<string, unknown> = {}, withResume = true) =>
    agent(1, {
      state: 'paused',
      pause: pause(pauseOver),
      scheduledResume: withResume ? { agentId: uuid(1), at: resumeAt, attempt: 0 } : null,
    } as unknown as Partial<Agent>);

  it('says « en pause · reprise à HH:MM » when a resume is planned', () => {
    expect(agentStateLabel(paused(), now)).toBe(`en pause · reprise à ${hhmm}`);
  });

  it('names the window when the automatic resume is off or cancelled', () => {
    expect(agentStateLabel(paused({}, false), now)).toBe('en pause · semaine');
  });

  it('says « en pause · reprise après réinitialisation » when the time is unknown', () => {
    const backoff = paused({
      resumeAt: null,
      windows: [{ id: 'week', label: 'semaine', percent: 91, resetsAt: null }],
    });
    expect(agentStateLabel(backoff, now)).toBe('en pause · reprise après réinitialisation');
  });

  it('says « en pause · session inconnue » when the session is unknown', () => {
    expect(agentStateLabel(paused({ blocked: 'session' }, false), now)).toBe(
      'en pause · session inconnue',
    );
  });

  it('never says « erreur » for a pause, whatever the case (SC-003)', () => {
    const cases = [paused(), paused({}, false), paused({ blocked: 'session' }, false)];
    for (const one of cases) expect(agentStateLabel(one, now)).not.toMatch(/erreur/);
  });
});

// 010 T017 — the row of an agent in a loop shows the stage of the run of its issue (contracts/ui.md).
describe('the stage of the issue on the row (010 US1)', () => {
  const run = (issueId: string, stage: string): Run => ({
    issueId,
    oid: 'default',
    workflow: defaultWorkflow(defaultDeliverySettings()),
    stage,
    status: 'active',
    bindings: {},
    entries: {},
    lastMessageId: null,
    history: [],
    reason: null,
    startedAt: iso,
    updatedAt: iso,
  });
  const agents = [agent(2, { role: 'dev' }), agent(3, { role: 'test' }), agent(4)];

  it('Given a running loop and a run at stage dev, Then both agents show « dev »', () => {
    const ws = {
      agents,
      freeTerminals: [],
      loops: [loop()],
      runs: [run('006-p12-base', 'dev'), run('other', 'test')],
    };
    const rows = agentRows(ws, [], names, now).rows;

    expect(rows.find((r) => r.agent.position === 2)?.stage).toBe('dev');
    expect(rows.find((r) => r.agent.position === 3)?.stage).toBe('dev');
    expect(rows.find((r) => r.agent.position === 4)?.stage).toBeNull();
  });

  it('Given no run (no workflow in the workspace), Then stage is null and the rest is as before', () => {
    const ws = { agents, freeTerminals: [], loops: [loop()] };
    const rows = agentRows(ws, [], names, now).rows;

    expect(rows.every((r) => r.stage === null)).toBe(true);
    expect(rows.find((r) => r.agent.position === 2)?.issueId).toBe('006-p12-base');
  });
});
