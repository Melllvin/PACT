import type { Agent, AgentState } from '../../shared/model';
import type { AgentSignal } from './adapters/types';

// data-model.md « AgentState — transitions ». Permissive on purpose: real CLIs show trust screens
// before any hook, and Codex without trusted hooks only reports the end of its turns (T049).

const LIVE: readonly AgentState[] = ['starting', 'awaiting-prompt', 'awaiting-answer', 'working'];

/** Agent after `signal`; the very same object when nothing changes (no save, no event). */
export function applySignal(agent: Agent, signal: AgentSignal): Agent {
  if (agent.state === 'closed') return agent;
  switch (signal.type) {
    case 'session-started': {
      const sessionId = signal.sessionId ?? agent.sessionId;
      const state =
        agent.state === 'starting' || agent.state === 'awaiting-answer'
          ? 'awaiting-prompt'
          : agent.state;
      return change(agent, { sessionId, state });
    }
    case 'prompt-submitted':
      return change(agent, {
        state: 'working',
        lastError: null,
        initialPrompt: agent.initialPrompt ?? signal.prompt ?? null,
      });
    case 'awaiting-answer':
      return change(agent, { state: 'awaiting-answer', lastError: null });
    case 'turn-finished': {
      const other =
        signal.sessionId !== undefined &&
        agent.sessionId !== null &&
        signal.sessionId !== agent.sessionId;
      if (other || !LIVE.includes(agent.state)) return agent;
      return change(agent, {
        state: 'done',
        sessionId: agent.sessionId ?? signal.sessionId ?? null,
      });
    }
    case 'failed':
      return change(agent, {
        state: 'error',
        lastError: { code: null, kind: signal.kind, message: signal.message },
      });
  }
}

/** The process ended without PACT closing the agent: « à reprendre » (exit code 0 included). */
export function applyExit(agent: Agent, code: number): Agent {
  if (agent.state === 'closed') return agent;
  const lastError =
    agent.lastError?.kind === 'rate-limit'
      ? { ...agent.lastError, code }
      : {
          code,
          kind: 'crash' as const,
          message:
            code === 0
              ? 'Le processus s’est terminé.'
              : `Le processus s’est arrêté (code ${String(code)}).`,
        };
  return { ...agent, state: 'error', lastError };
}

function change(agent: Agent, fields: Partial<Agent>): Agent {
  const changed = (Object.keys(fields) as (keyof Agent)[]).some(
    (key) => JSON.stringify(fields[key]) !== JSON.stringify(agent[key]),
  );
  return changed ? { ...agent, ...fields } : agent;
}
