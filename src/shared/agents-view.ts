import type { Agent, Loop, TodoItem, Workspace } from './model';
import type { Role } from './primitives';
import { ORDER } from './todo';

/** 006 — what the Agents column and the graph read of an agent; pure, no DOM. */

const STATE_LABELS: Record<Agent['state'], string> = {
  starting: 'démarre',
  working: 'travaille',
  'awaiting-prompt': 'attend une consigne',
  'awaiting-answer': 'attend une réponse',
  done: 'fini',
  error: 'erreur',
  closed: 'fermé',
};

const twoDigits = (n: number) => String(n).padStart(2, '0');

/** The state of an agent in words; a scheduled resume says when, in local time (data-model). */
export function agentStateLabel(agent: Agent, now: Date): string {
  if (agent.scheduledResume) {
    const at = new Date(agent.scheduledResume.at);
    // A resume already past is about to fire: the state label tells more than a time gone by.
    if (at.getTime() > now.getTime()) {
      return `reprise à ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
    }
  }
  if (agent.state === 'error' && agent.lastError?.kind === 'rate-limit') return 'limite de débit';
  return STATE_LABELS[agent.state];
}

export const LOOP_ROUNDS = 3;

/** The role of an agent in words, as the column and the graph name it. */
export const ROLE_LABELS: Record<Role, string> = {
  orchestrator: 'orchestrateur',
  spec: 'spec',
  design: 'design',
  dev: 'dev',
  test: 'test',
  recap: 'recap',
};

export type AgentPhase = {
  label: string;
  issueId?: string;
  round?: { n: number; max: number };
};

const LOOP_LABELS = {
  passed: 'boucle terminée',
  escalated: 'boucle arrêtée',
} as const;

/** The phase of an agent: its loop (R5), else its role when it has one of the three, else none. */
export function agentPhase(agent: Agent, loops: readonly Loop[]): AgentPhase | null {
  const own = loops.filter(
    (loop) =>
      loop.state !== 'closed' && (loop.devAgentId === agent.id || loop.testAgentId === agent.id),
  );
  const loop = [...own].reverse().find((l) => l.state === 'running') ?? own.at(-1);
  if (loop) {
    if (loop.state === 'running') {
      return {
        label: 'dev ↔ test',
        issueId: loop.issueId,
        round: { n: loop.round, max: LOOP_ROUNDS },
      };
    }
    return { label: LOOP_LABELS[loop.state as keyof typeof LOOP_LABELS], issueId: loop.issueId };
  }
  if (agent.role === 'spec' || agent.role === 'design' || agent.role === 'recap') {
    return { label: agent.role };
  }
  return null;
}

export type AgentRow = {
  agent: Agent;
  name: string;
  role: Role | null;
  stateLabel: string;
  issueId: string | null;
  todo: TodoItem | null;
  pending: number;
};

export type AgentsView = {
  head: TodoItem[];
  rows: AgentRow[];
  agentCount: number;
  pendingCount: number;
};

/** The kinds of item that aim at one agent: they go on its row; the others go in the head. */
const ROW_KINDS: readonly TodoItem['kind'][] = [
  'answer',
  'decide',
  'rate-limit',
  'wake-held',
  'review',
  'prompt',
];

const rank = (item: TodoItem) => ORDER.indexOf(item.kind);

/** 006 — the Agents column: `deriveTodos` grouped by agent, no action computed again (SC-005). */
export function agentRows(
  workspace: Pick<Workspace, 'agents' | 'freeTerminals' | 'loops'>,
  todos: readonly TodoItem[],
  names: (cliId: string) => string,
  now: Date,
): AgentsView {
  const ids = new Set(workspace.agents.map((agent) => agent.id));
  const own = (item: TodoItem) => ROW_KINDS.includes(item.kind) && ids.has(item.agentId);
  const head = todos.filter((item) => !own(item));
  const rows = workspace.agents.map((agent): AgentRow => {
    const items = todos.filter((item) => own(item) && item.agentId === agent.id);
    const first = [...items].sort((a, b) => rank(a) - rank(b))[0] ?? null;
    return {
      agent,
      name: `${names(agent.cliId)} ${String(agent.position)}`,
      role: agent.role,
      stateLabel: agentStateLabel(agent, now),
      issueId: agentPhase(agent, workspace.loops)?.issueId ?? null,
      todo: first,
      pending: items.length,
    };
  });
  const group = (row: AgentRow) => (row.todo ? 0 : row.agent.role === 'orchestrator' ? 1 : 2);
  rows.sort(
    (a, b) =>
      group(a) - group(b) ||
      (a.todo && b.todo ? rank(a.todo) - rank(b.todo) : 0) ||
      a.agent.position - b.agent.position,
  );
  return {
    head,
    rows,
    agentCount: rows.length,
    pendingCount: todos.filter((item) => item.kind !== 'info').length,
  };
}

/** 006 FR-023 — the agents an orchestrator launched, by position; never itself nor the user's. */
export function agentsLaunchedBy(
  workspace: Pick<Workspace, 'agents'>,
  orchestratorId: string,
): Agent[] {
  return workspace.agents
    .filter((agent) => agent.launchedBy === orchestratorId && agent.id !== orchestratorId)
    .sort((a, b) => a.position - b.position);
}
