import { describe, expect, it } from 'vitest';
import { agentsLaunchedBy } from '../../../src/shared/agents-view';
import { agentSchema, type Agent } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import type { UsageState } from '../../../src/shared/usage';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const agent = (n: number, overrides: Partial<Agent> = {}): Agent => ({
  id: uuid(n),
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
  state: 'awaiting-prompt',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  pause: null,
  effort: null,
  ...overrides,
});

// 006 US4 — agents closed with their orchestrator (FR-023 … FR-026): what reads them.

const group = (agents: Agent[]) => ({ agents });

describe('agentsLaunchedBy', () => {
  it('orders by position and ignores the ones launched by someone else', () => {
    const lead = agent(1, { role: 'orchestrator' });
    const rest = [
      agent(4, { launchedBy: lead.id }),
      agent(2, { launchedBy: lead.id }),
      agent(3, { launchedBy: uuid(99) }),
    ];
    expect(agentsLaunchedBy(group([lead, ...rest]), lead.id).map((a) => a.position)).toEqual([
      2, 4,
    ]);
  });

  it('never lists the orchestrator itself, even launched by itself', () => {
    const lead = agent(1, { role: 'orchestrator' });
    const odd = { ...lead, launchedBy: lead.id };
    expect(agentsLaunchedBy(group([odd]), lead.id)).toEqual([]);
  });
});

describe('a workspace file saved before `closedWhileWorking`', () => {
  it('still loads, the field reading false', () => {
    const old = Object.fromEntries(
      Object.entries(agent(1, { state: 'closed' })).filter(([key]) => key !== 'closedWhileWorking'),
    );
    expect(old).not.toHaveProperty('closedWhileWorking');
    const parsed = agentSchema.parse(old);
    expect(parsed.state).toBe('closed');
    expect(parsed.closedWhileWorking).toBe(false);
  });

  it('keeps the field when it is there', () => {
    const parsed = agentSchema.parse(agent(1, { state: 'closed', closedWhileWorking: true }));
    expect(parsed.closedWhileWorking).toBe(true);
  });
});

describe('À faire with closed agents', () => {
  const workspace = (agents: Agent[]) => ({
    agents,
    freeTerminals: [],
    mainBranch: 'main',
  });
  const closed = (n: number) =>
    agent(n, { state: 'closed', closedWhileWorking: true, lastReport: null });
  const NOW = new Date('2026-11-03T14:00:00');
  const hot: UsageState = {
    cliId: 'claude-code',
    account: 'default',
    reading: {
      cliId: 'claude-code',
      account: 'default',
      readAt: NOW.toISOString(),
      windows: [{ id: 'five-hour', label: '5 h', usedPercent: 90, resetsAt: null, minutes: 300 }],
    },
    shares: [],
    level: 'warn',
  };
  const usage = { states: [hot], thresholds: { warn: 80, critical: 95 }, now: NOW };

  it('raises nothing for a closed agent, even listed as changed', () => {
    const lead = { ...closed(1), role: 'orchestrator' as const };
    expect(deriveTodos(workspace([lead, closed(2)]), () => 'Claude Code', { a: 2 })).toEqual([]);
  });

  it('raises no usage alert for a CLI that only closed agents use', () => {
    const only = deriveTodos(workspace([closed(1)]), () => 'Claude Code', {}, usage);
    expect(only).toEqual([]);
    const live = deriveTodos(
      workspace([closed(1), agent(2, { state: 'working' })]),
      () => 'Claude Code',
      {},
      usage,
    );
    expect(live.map((todo) => todo.kind)).toEqual(['usage-limit']);
  });
});
