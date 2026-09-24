import { describe, expect, it } from 'vitest';
import type { AgentSignal } from '../../../../src/main/agents/adapters/types';
import { applyExit, applySignal } from '../../../../src/main/agents/agent-state';
import type { Agent, AgentState } from '../../../../src/shared/model';

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

  it('keeps a closed agent closed', () => {
    const closed = agent({ state: 'closed' });
    expect(applyExit(closed, 0)).toBe(closed);
  });
});
