import type { Agent } from '../../shared/model';
import type { FocusTab } from './FocusView';

/** What an agent has to show in its Focus now (#43). */
export type TabContent = {
  /** The port of the agent is served: Aperçu. */
  served: boolean;
  /** Files of its diff: Changements. */
  changedFiles: number;
  /** Entries of the orchestrator's journal: Actions. */
  actions: number;
  /** Reports of the loops: Rapports. */
  reports: number;
  /** Conflicts of a stopped integration: Conflits. */
  conflicts?: number;
};

/**
 * 006 #43 — the tabs of the Focus, in the order of the bar. Terminal is always there; each other
 * tab is there once it has something to show, and Actions and Rapports belong to the orchestrator.
 */
export function visibleTabs(agent: Pick<Agent, 'role'>, content: TabContent): FocusTab[] {
  const lead = agent.role === 'orchestrator';
  return [
    'terminal',
    ...(content.served ? (['preview'] as const) : []),
    ...(content.changedFiles > 0 ? (['changes'] as const) : []),
    ...((content.conflicts ?? 0) > 0 ? (['conflicts'] as const) : []),
    ...(lead && content.actions > 0 ? (['actions'] as const) : []),
    ...(lead && content.reports > 0 ? (['reports'] as const) : []),
  ];
}
