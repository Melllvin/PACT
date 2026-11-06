import type { Agent, AgentState } from '../../shared/model';
import { isPointer } from '../../shared/exchanges';
import type { AgentSignal } from './adapters/types';

// data-model.md « AgentState — transitions ». Permissive on purpose: real CLIs show trust screens
// before any hook, and Codex without trusted hooks only reports the end of its turns (T049).

const LIVE: readonly AgentState[] = ['starting', 'awaiting-prompt', 'awaiting-answer', 'working'];

/** Agent after `signal`; the very same object when nothing changes (no save, no event). */
export function applySignal(agent: Agent, signal: AgentSignal): Agent {
  const next = nextAgent(agent, signal);
  if (!('awaiting' in next) || (next.state === 'awaiting-answer' && next.awaiting)) return next;
  const answered = { ...next };
  delete answered.awaiting;
  return answered;
}

/** A question, or else a permission; a Notification without ruleKey keeps the question. */
function awaitingOf(agent: Agent, signal: Extract<AgentSignal, { type: 'awaiting-answer' }>) {
  if (signal.question) return 'question';
  const asked = agent.state === 'awaiting-answer' && agent.awaiting === 'question';
  return asked && signal.ruleKey === undefined ? 'question' : undefined;
}

function nextAgent(agent: Agent, signal: AgentSignal): Agent {
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
    // A prompt taken again (typed, or the CLI's own resume after a quota) ends any scheduled resume.
    case 'prompt-submitted':
      return change(agent, {
        state: 'working',
        lastError: null,
        scheduledResume: null,
        // A wake pointer is not the first prompt of the agent (007 R11).
        initialPrompt:
          agent.initialPrompt ?? (signal.prompt && isPointer(signal.prompt) ? null : signal.prompt) ?? null,
      });
    case 'awaiting-answer':
      return change(agent, {
        state: 'awaiting-answer',
        awaiting: awaitingOf(agent, signal),
        lastError: null,
        scheduledResume: null,
      });
    case 'turn-finished': {
      const other =
        signal.sessionId !== undefined &&
        agent.sessionId !== null &&
        signal.sessionId !== agent.sessionId;
      if (other || !LIVE.includes(agent.state)) return agent;
      return change(agent, {
        state: 'done',
        sessionId: agent.sessionId ?? signal.sessionId ?? null,
        scheduledResume: null,
      });
    }
    // A scheduled resume lasts only as long as the rate limit (FR-036).
    case 'failed':
      return change(agent, {
        state: 'error',
        lastError: { code: null, kind: signal.kind, message: signal.message },
        ...(signal.kind === 'rate-limit' ? {} : { scheduledResume: null }),
      });
  }
}

/** The process ended without PACT closing the agent: « à reprendre » (exit code 0 included). */
export function applyExit(agent: Agent, code: number | null): Agent {
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
              : code === null
                ? 'Le processus s’est arrêté.'
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

/**
 * 007 R5, R6 — what the prompt of an agent holds, as far as PACT can tell from the keys it saw.
 * `unknown`: a paste or a movement made the content impossible to count; `stuck`: a pointer was
 * typed and never submitted. Either way the prompt is not empty.
 */
export type Draft = { count: number; unknown: boolean; stuck: boolean };

export const EMPTY_DRAFT: Draft = { count: 0, unknown: false, stuck: false };

export const isDraftEmpty = (draft: Draft): boolean =>
  draft.count === 0 && !draft.unknown && !draft.stuck;

/** The keys the user typed in the terminal; those typed to answer a question are ignored. */
export function applyTyped(draft: Draft, data: string, state: AgentState): Draft {
  if (state === 'awaiting-answer') return draft;
  let next = draft;
  // A paste may hold line breaks of its own: it is skipped whole, and leaves the content unknown.
  const text = data.replace(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g, '\x1b[200~');
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] ?? '';
    if (char === '\r') next = EMPTY_DRAFT;
    else if (char === '\x1b') {
      // ESC + CR is Shift+Enter: a line break, so something is there. Any other sequence (paste,
      // arrows, home…) moves the cursor or pastes: the content is unknown until Enter.
      if (chars[i + 1] === '\r') {
        next = { ...next, count: next.count + 1 };
        i += 1;
      } else next = { ...next, unknown: true };
    } else if (char === '\x7f' || char === '\b') {
      next = { ...next, count: Math.max(0, next.count - 1) };
    } else if (char < ' ') next = { ...next, unknown: true };
    else next = { ...next, count: next.count + 1 };
  }
  return next;
}

/** A submitted prompt is empty again, a pointer left in it included. */
export function draftAfterSignal(draft: Draft, signal: AgentSignal): Draft {
  return signal.type === 'prompt-submitted' ? EMPTY_DRAFT : draft;
}

/** A pointer typed and never submitted (R6): the prompt is busy until Enter. */
export const markStuck = (draft: Draft): Draft => ({ ...draft, stuck: true });
