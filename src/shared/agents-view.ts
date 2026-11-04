import type { Agent, Loop } from './model';

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
