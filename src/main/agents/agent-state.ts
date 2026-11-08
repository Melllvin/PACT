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
  if (agent.state === 'closed' || agent.state === 'paused') return agent;
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
          agent.initialPrompt ??
          (signal.prompt && isPointer(signal.prompt) ? null : signal.prompt) ??
          null,
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
  if (agent.state === 'closed' || agent.state === 'paused') return agent;
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
  // What the terminal answers by itself to the CLI or to ConPTY is no key of the user.
  const text = skipTerminalReplies(skipPastes(data));
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as string;
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

// The replies xterm sends on its own through `onData`, to a query of the CLI or of ConPTY (which asks
// for the cursor position as it starts, on Windows): position (CPR), status, device attributes,
// mode and window reports, focus, the kitty keyboard flags, then the OSC and DCS answers. They
// reach `typed` like any key, but none is typed by the user, and none fills the prompt. A key that
// shares a form with a reply (Shift+F3 is CSI 1;2 R) is dropped too: it writes nothing in a prompt.
const TERMINAL_REPLIES = new RegExp(
  [
    String.raw`\x1b\[\??\d+;\d+(?:;\d+)?R`,
    String.raw`\x1b\[[?>=]\d*(?:;\d+)*c`,
    String.raw`\x1b\[\??\d+n`,
    String.raw`\x1b\[[IO]`,
    String.raw`\x1b\[\??\d+;\d+\$y`,
    String.raw`\x1b\[\d+(?:;\d+){0,2}t`,
    String.raw`\x1b\[\?\d*u`,
    String.raw`\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)`,
    String.raw`\x1bP[^\x1b]*\x1b\\`,
  ].join('|'),
  'g',
);

/** `data` without the replies the terminal made by itself. */
export const skipTerminalReplies = (data: string): string => data.replace(TERMINAL_REPLIES, '');

const PASTE_OPEN = '\x1b[200~';
const PASTE_MARK = '\x1b\x00';
const PASTE_CLOSE = '\x1b[201~';

/** Each bracketed paste is cut down to a mark that leaves the content unknown, and counts as no key. */
function skipPastes(data: string): string {
  let out = '';
  let rest = data;
  for (;;) {
    const start = rest.indexOf(PASTE_OPEN);
    if (start < 0) return out + rest;
    out += rest.slice(0, start) + PASTE_MARK;
    const end = rest.indexOf(PASTE_CLOSE, start);
    if (end < 0) return out;
    rest = rest.slice(end + PASTE_CLOSE.length);
  }
}
