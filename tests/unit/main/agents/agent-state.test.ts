import { describe, expect, it } from 'vitest';
import type { AgentSignal } from '../../../../src/main/agents/adapters/types';
import {
  EMPTY_DRAFT,
  applyExit,
  applySignal,
  applyTyped,
  draftAfterSignal,
  isDraftEmpty,
  markStuck,
} from '../../../../src/main/agents/agent-state';
import { agentSchema, type Agent, type AgentState } from '../../../../src/shared/model';

// data-model.md « AgentState — transitions », research.md R6 and the T049 findings.

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: 'abcdef0123456789',
  position: 1,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: 'agent/claude-code-1',
  worktreePath: '/repo/.worktrees/claude-code-1',
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'starting',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: null,
  launchedBy: null,
  closedWhileWorking: false,
  effort: null,
  ...overrides,
});

const rateLimited = {
  state: 'error',
  lastError: { code: null, kind: 'rate-limit', message: 'Limite atteinte' },
} as const;

describe('applySignal', () => {
  it('follows starting → awaiting-prompt → working → done → working', () => {
    const steps: [AgentSignal, AgentState][] = [
      [{ type: 'session-started', sessionId: 's1' }, 'awaiting-prompt'],
      [{ type: 'prompt-submitted', prompt: 'Ajoute un test' }, 'working'],
      [{ type: 'turn-finished', sessionId: 's1' }, 'done'],
      [{ type: 'prompt-submitted', prompt: 'Encore' }, 'working'],
    ];
    let current = agent();
    for (const [signal, state] of steps) {
      current = applySignal(current, signal);
      expect(current.state).toBe(state);
    }
    expect(current.sessionId).toBe('s1');
  });

  it('keeps the first prompt as the initial prompt, for « Relancer »', () => {
    let current = applySignal(agent({ state: 'awaiting-prompt' }), {
      type: 'prompt-submitted',
      prompt: 'Ajoute un test',
    });
    current = applySignal(
      { ...current, state: 'done' },
      { type: 'prompt-submitted', prompt: 'Et un autre' },
    );
    expect(current.initialPrompt).toBe('Ajoute un test');
  });

  it('waits for an answer, from the start too (trust screens come before any hook)', () => {
    const signal: AgentSignal = {
      type: 'awaiting-answer',
      summary: 'Faire confiance au dossier ?',
    };
    expect(applySignal(agent(), signal).state).toBe('awaiting-answer');
    expect(applySignal(agent({ state: 'working' }), signal).state).toBe('awaiting-answer');
  });

  it('reaches the prompt once the trust screen is answered in the terminal', () => {
    expect(
      applySignal(agent({ state: 'awaiting-answer' }), { type: 'session-started', sessionId: 's' })
        .state,
    ).toBe('awaiting-prompt');
  });

  it('keeps the session id of a resumed agent when SessionStart has none', () => {
    const resumed = applySignal(agent({ sessionId: 's1' }), { type: 'session-started' });
    expect(resumed.sessionId).toBe('s1');
  });

  it('does not go back to the prompt when a session starts mid-turn', () => {
    const working = agent({ state: 'working', sessionId: 's1' });
    expect(applySignal(working, { type: 'session-started', sessionId: 's1' })).toBe(working);
  });

  it('ends the turn from any live state: Codex without trusted hooks only sends notify', () => {
    for (const state of ['starting', 'awaiting-prompt', 'awaiting-answer', 'working'] as const) {
      expect(applySignal(agent({ state }), { type: 'turn-finished' }).state).toBe('done');
    }
  });

  it('takes the session id from notify when SessionStart never came (Codex, R6)', () => {
    const done = applySignal(agent({ state: 'working' }), {
      type: 'turn-finished',
      sessionId: 't1',
    });
    expect(done.sessionId).toBe('t1');
  });

  it("ignores the end of another session's turn (Codex title thread)", () => {
    const working = agent({ state: 'working', sessionId: 's1' });
    expect(applySignal(working, { type: 'turn-finished', sessionId: 'other' })).toBe(working);
  });

  it('records a failure and clears it once the agent works again', () => {
    const failed = applySignal(agent({ state: 'working' }), {
      type: 'failed',
      kind: 'rate-limit',
      message: 'Limite atteinte',
    });
    expect(failed).toMatchObject(rateLimited);
    const resumed = applySignal(failed, { type: 'prompt-submitted', prompt: 'continue' });
    expect(resumed).toMatchObject({ state: 'working', lastError: null });
  });

  it('keeps a rate limit error when the failed turn reports its end', () => {
    const failed = agent(rateLimited);
    expect(applySignal(failed, { type: 'turn-finished' })).toBe(failed);
  });

  it('keeps a scheduled resume only while the rate limit lasts (FR-036)', () => {
    const scheduledResume = { agentId: 'a1', at: '2030-01-01T09:30:00.000Z', attempt: 0 };
    const limited = agent({ ...rateLimited, scheduledResume });
    const again = { type: 'failed', kind: 'rate-limit', message: 'Toujours limité' } as const;
    expect(applySignal(limited, again).scheduledResume).toEqual(scheduledResume);
    expect(applySignal(limited, { type: 'awaiting-answer', summary: 'Continuer ?' })).toMatchObject(
      { state: 'awaiting-answer', scheduledResume: null },
    );
    expect(
      applySignal(limited, { type: 'failed', kind: 'crash', message: 'Erreur' }),
    ).toMatchObject({ state: 'error', scheduledResume: null });
  });

  // T162 — what the agent waits on: a permission or a question (FR-024a).
  it('tells a question from a permission, and forgets it once answered', () => {
    const asked = applySignal(agent({ state: 'working' }), {
      type: 'awaiting-answer',
      summary: 'Quelle base ?',
      question: true,
    });
    expect(asked).toMatchObject({ state: 'awaiting-answer', awaiting: 'question' });
    // The Notification that follows the PermissionRequest has no ruleKey: still the question.
    expect(
      applySignal(asked, { type: 'awaiting-answer', summary: 'Claude needs your input' }),
    ).toMatchObject({ awaiting: 'question' });
    expect(applySignal(asked, { type: 'prompt-submitted' }).awaiting).toBeUndefined();
    expect(applySignal(asked, { type: 'turn-finished' }).awaiting).toBeUndefined();
    const permission = applySignal(agent({ state: 'working' }), {
      type: 'awaiting-answer',
      summary: 'rm x',
      ruleKey: 'Bash(rm x)',
    });
    expect(permission.awaiting).toBeUndefined();
    expect(
      applySignal(asked, { type: 'awaiting-answer', summary: 'rm x', ruleKey: 'Bash(rm x)' })
        .awaiting,
    ).toBeUndefined();
  });

  it('returns the same agent when nothing changes', () => {
    const done = agent({ state: 'done', sessionId: 's1' });
    expect(applySignal(done, { type: 'turn-finished', sessionId: 's1' })).toBe(done);
    const waiting = agent({ state: 'awaiting-answer' });
    expect(applySignal(waiting, { type: 'awaiting-answer', summary: 'x' })).toBe(waiting);
  });

  it('never revives a closed agent', () => {
    const closed = agent({ state: 'closed' });
    expect(applySignal(closed, { type: 'prompt-submitted', prompt: 'x' })).toBe(closed);
  });
});

describe('applyExit', () => {
  it('turns an exit PACT did not ask for into a crash with its code', () => {
    expect(applyExit(agent({ state: 'working' }), 1)).toMatchObject({
      state: 'error',
      lastError: { code: 1, kind: 'crash' },
    });
    expect(applyExit(agent({ state: 'done' }), 0)).toMatchObject({
      state: 'error',
      lastError: { code: 0, kind: 'crash' },
    });
  });

  it('keeps the rate limit reason of an agent that exits after it', () => {
    expect(applyExit(agent(rateLimited), 1)).toMatchObject({
      state: 'error',
      lastError: { code: 1, kind: 'rate-limit', message: 'Limite atteinte' },
    });
  });

  it('saves a crash without an exit code as a valid agent (T146)', () => {
    const exited = applyExit(agent({ state: 'working' }), null);
    expect(exited.lastError).toEqual({
      code: null,
      kind: 'crash',
      message: 'Le processus s’est arrêté.',
    });
    expect(agentSchema.safeParse(exited).success).toBe(true);
  });

  it('keeps a closed agent closed', () => {
    const closed = agent({ state: 'closed' });
    expect(applyExit(closed, 0)).toBe(closed);
  });
});

// 007 T019 — what the prompt of an agent holds (R5, R6), and the pointer that is not its first prompt
// (R11). API fixed for the dev, all pure, in agent-state.ts:
//   type Draft = { count: number; unknown: boolean; stuck: boolean }
//   EMPTY_DRAFT                         { count: 0, unknown: false, stuck: false }
//   applyTyped(draft, data, state)      what the user typed (`AgentManager.typed`)
//   draftAfterSignal(draft, signal)     `prompt-submitted` empties it
//   markStuck(draft)                    a pointer typed but never submitted (R6): busy until Enter
//   isDraftEmpty(draft)                 count 0, not unknown, not stuck
describe('the draft of the prompt (R5)', () => {
  const type = (data: string, from = EMPTY_DRAFT, state: AgentState = 'awaiting-prompt') =>
    applyTyped(from, data, state);

  it('Given an empty prompt, When the user types characters, Then the draft counts them and is no longer empty', () => {
    expect(isDraftEmpty(EMPTY_DRAFT)).toBe(true);
    expect(type('a')).toMatchObject({ count: 1, unknown: false });
    expect(type('abc')).toMatchObject({ count: 3 });
    expect(type('éé')).toMatchObject({ count: 2 });
    expect(isDraftEmpty(type('a'))).toBe(false);
  });

  it('Given three characters, When the user erases them one by one, Then the draft is empty again, and erasing an empty one changes nothing', () => {
    let draft = type('abc');
    draft = type('\x7f', draft);
    expect(draft.count).toBe(2);
    draft = type('\x7f', type('\x7f', draft));
    expect(isDraftEmpty(draft)).toBe(true);
    expect(isDraftEmpty(type('\x7f'))).toBe(true);
  });

  it('Given an empty prompt, When the user pastes, Then the content is unknown, hence not empty', () => {
    const pasted = type('\x1b[200~du texte collé\x1b[201~');
    expect(pasted.unknown).toBe(true);
    expect(isDraftEmpty(pasted)).toBe(false);
  });

  it('Given an empty prompt, When a movement sequence arrives (arrow, home), Then the content is unknown', () => {
    expect(type('\x1b[D').unknown).toBe(true);
    expect(type('\x1b[H').unknown).toBe(true);
    expect(isDraftEmpty(type('\x1b[D'))).toBe(false);
  });

  it('Given an unknown content, When the user erases or types more, Then it stays unknown, until Enter', () => {
    const unknown = type('\x1b[D');
    expect(type('\x7f', unknown).unknown).toBe(true);
    expect(type('a', unknown).unknown).toBe(true);
    expect(isDraftEmpty(type('\x7f\x7f\x7f', unknown))).toBe(false);
    expect(isDraftEmpty(type('\r', unknown))).toBe(true);
  });

  it('Given a draft, When Enter (\\r) is typed, Then it is empty', () => {
    expect(isDraftEmpty(type('\r', type('abc')))).toBe(true);
    expect(isDraftEmpty(type('fin\r', type('abc')))).toBe(true);
  });

  it('Given an empty prompt, When Shift+Enter (a line break) is typed, Then the prompt is not empty and Enter was not pressed', () => {
    expect(isDraftEmpty(type('\x1b\r'))).toBe(false);
  });

  it('Given a draft, When the CLI reports prompt-submitted, Then it is empty, stuck pointer included', () => {
    const typed = type('abc');
    expect(isDraftEmpty(draftAfterSignal(typed, { type: 'prompt-submitted', prompt: 'abc' }))).toBe(
      true,
    );
    expect(isDraftEmpty(draftAfterSignal(type('\x1b[D'), { type: 'prompt-submitted' }))).toBe(true);
    expect(
      isDraftEmpty(draftAfterSignal(markStuck(EMPTY_DRAFT), { type: 'prompt-submitted' })),
    ).toBe(true);
  });

  it('Given a draft, When another signal arrives, Then the draft is unchanged', () => {
    const typed = type('abc');
    expect(draftAfterSignal(typed, { type: 'turn-finished' })).toEqual(typed);
    expect(draftAfterSignal(typed, { type: 'session-started', sessionId: 's' })).toEqual(typed);
  });

  it('Given an agent that awaits an answer, When keys are typed, Then they are ignored: they answer a question, not the prompt', () => {
    expect(type('oui', EMPTY_DRAFT, 'awaiting-answer')).toEqual(EMPTY_DRAFT);
    const typed = type('ab');
    expect(type('xyz\x7f\x7f\x7f', typed, 'awaiting-answer')).toEqual(typed);
    // Not even its Enter empties what was in the prompt before the question.
    expect(type('\r', typed, 'awaiting-answer')).toEqual(typed);
  });
});

describe('a pointer typed but never submitted (R6)', () => {
  it('Given a pointer left in the prompt, When it is marked stuck, Then the prompt counts as busy until Enter or prompt-submitted', () => {
    const stuck = markStuck(EMPTY_DRAFT);
    expect(stuck.stuck).toBe(true);
    expect(isDraftEmpty(stuck)).toBe(false);
    expect(isDraftEmpty(applyTyped(stuck, '\r', 'awaiting-prompt'))).toBe(true);
  });
});

describe('the pointer is not the initial prompt (R11)', () => {
  const POINTER = '1 événement, lis get_events';

  it('Given an agent without initial prompt, When it submits a pointer, Then it works and the initial prompt stays empty', () => {
    const next = applySignal(agent({ state: 'awaiting-prompt' }), {
      type: 'prompt-submitted',
      prompt: POINTER,
    });
    expect(next.state).toBe('working');
    expect(next.initialPrompt).toBeNull();
  });

  it('Given the same agent, When the pointer is the file variant, Then it is ignored too', () => {
    const next = applySignal(agent({ state: 'awaiting-prompt' }), {
      type: 'prompt-submitted',
      prompt: '3 événements, lis .pact/events.md',
    });
    expect(next.initialPrompt).toBeNull();
  });

  it('Given a pointer already submitted, When the first instruction is played, Then it becomes the initial prompt, and only the first', () => {
    let current = applySignal(agent({ state: 'awaiting-prompt' }), {
      type: 'prompt-submitted',
      prompt: POINTER,
    });
    current = applySignal(current, { type: 'turn-finished' });
    current = applySignal(current, { type: 'prompt-submitted', prompt: 'Corrige a.ts\nPuis b.ts' });
    expect(current.initialPrompt).toBe('Corrige a.ts\nPuis b.ts');
    current = applySignal(current, { type: 'turn-finished' });
    current = applySignal(current, { type: 'prompt-submitted', prompt: POINTER });
    current = applySignal(current, { type: 'prompt-submitted', prompt: 'Autre consigne' });
    expect(current.initialPrompt).toBe('Corrige a.ts\nPuis b.ts');
  });
});

// 009 T004 — a paused agent has no process: no signal and no exit changes it (research R1, data-model
// « Transitions »).

describe('a paused agent', () => {
  const paused = {
    ...agent({ sessionId: 'session-1' }),
    state: 'paused',
    pause: {
      cliId: 'claude-code',
      account: 'default',
      cause: 'threshold',
      windows: [{ id: 'five-hour', label: '5 h', percent: 91, resetsAt: null }],
      resumeAt: null,
      pausedAt: '2026-11-08T10:00:00.000Z',
      midTurn: false,
      saved: true,
      closedQuestion: null,
      blocked: null,
    },
  } as unknown as Agent;

  const signals: AgentSignal[] = [
    { type: 'session-started', sessionId: 'session-2' },
    { type: 'prompt-submitted' },
    { type: 'prompt-submitted', prompt: 'continue' },
    { type: 'awaiting-answer', summary: 'Exécuter ?' },
    { type: 'turn-finished' },
    { type: 'failed', kind: 'rate-limit', message: 'Limite atteinte' },
    { type: 'failed', kind: 'crash', message: 'boom' },
  ];

  it.each(signals)('stays as it is on the signal %j', (signal) => {
    expect(applySignal(paused, signal)).toBe(paused);
  });

  it.each([0, 1, null])('stays paused when the process ends with code %j', (code) => {
    expect(applyExit(paused, code)).toBe(paused);
  });
});
