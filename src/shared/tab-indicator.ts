import type { AgentState } from './model';

export type TabIndicator = 'waiting' | 'error';

/** ◆ while an agent waits for an answer, otherwise ✕ while one is in error (FR-030). */
export function tabIndicator(agents: { state: AgentState }[]): TabIndicator | null {
  if (agents.some((agent) => agent.state === 'awaiting-answer')) return 'waiting';
  if (agents.some((agent) => agent.state === 'error')) return 'error';
  return null;
}
