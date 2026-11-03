import { describe, expect, it } from 'vitest';
import { agentPhase, agentStateLabel } from '../../../src/shared/agents-view';
import { AGENT_COLORS, type Agent, type Loop } from '../../../src/shared/model';

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
