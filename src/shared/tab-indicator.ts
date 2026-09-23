import type { Agent } from './model.js';
export const tabIndicator = (agents: Agent[]): '◆' | '✕' | null =>
  agents.some((a) => a.state === 'awaiting-answer')
    ? '◆'
    : agents.some((a) => a.state === 'error')
      ? '✕'
      : null;
