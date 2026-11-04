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
import { deriveTodos } from '../../../src/shared/todo';

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

  it('reads a passed loop as « boucle terminée », without round', () => {
    const phase = agentPhase(agent(2), [loop({ state: 'passed' })]);
    expect(phase).toMatchObject({ label: 'boucle terminée', issueId: '006-p12-base' });
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
      loop({ issueId: 'b', state: 'passed' }),
      loop({ issueId: 'c', state: 'running', round: 3 }),
      loop({ issueId: 'd', state: 'escalated' }),
    ]);
    expect(phase).toMatchObject({ label: 'dev ↔ test', issueId: 'c', round: { n: 3, max: 3 } });
  });

  it('takes the last loop of the array when none is running', () => {
    const phase = agentPhase(agent(2), [
      loop({ issueId: 'a', state: 'escalated' }),
      loop({ issueId: 'b', state: 'closed' }),
      loop({ issueId: 'c', state: 'passed' }),
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
  extra: Partial<
    Pick<Workspace, 'integrationRequests' | 'loops' | 'issues' | 'publishRequests'>
  > & { freeTerminals?: FreeTerminal[] } = {},
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
    const result = view(ws, deriveTodos(ws, names, [uuid(1)]));
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

  it.each([
    'integration-request',
    'publish-issues',
    'loop-escalated',
    'overlap',
    'usage-limit',
  ] as const)('sends « %s » to the head, even when it targets an agent', (kind) => {
    const ws = workspaceOf([agent(1)]);
    const item = todo(uuid(1), kind);
    const result = view(ws, [item]);
    expect(result.head).toEqual([item]);
    expect(result.rows[0]?.todo).toBeNull();
    expect(result.rows[0]?.pending).toBe(0);
  });

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
    const items = [...deriveTodos(ws, names), todo(uuid(2), 'overlap')];
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
        integrationRequests: [
          { id: uuid(50), agentId: uuid(3), mode: 'squash', message: 'feat: x', requestedAt: iso },
        ],
      },
    );
    const items = deriveTodos(ws, names, [uuid(3)]);
    const result = view(ws, items);
    const placed = result.rows.reduce((sum, row) => sum + row.pending, result.head.length);
    expect(placed).toBe(items.length);
    expect(result.head.map((item) => item.kind).sort()).toEqual(['info', 'integration-request']);
  });
});
