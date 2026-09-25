import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySignal } from '../../../../src/main/agents/agent-state';
import {
  AutoResume,
  BACKOFF_MINUTES,
  nextResume,
  type Clock,
} from '../../../../src/main/agents/auto-resume';
import type { Agent, ScheduledResume } from '../../../../src/shared/model';

// T103 — US7, FR-036: the resume scheduled after a rate limit, on a simulated clock.

const MINUTE = 60_000;
const start = new Date('2030-01-01T09:00:00.000Z');

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'a1',
  workspaceId: 'w1',
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  position: 1,
  color: 'violet',
  branch: 'agent/fake-1',
  baseBranch: 'main',
  worktreePath: '/w/.worktrees/fake-1',
  port: 3001,
  startCommand: null,
  state: 'error',
  sessionId: 's1',
  initialPrompt: null,
  lastError: { code: null, kind: 'rate-limit', message: 'Rate limited' },
  scheduledResume: null,
  alwaysAllowRules: [],
  ...overrides,
});

const clock: Clock = {
  now: () => new Date(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => {
    clearTimeout(timer);
  },
};

describe('nextResume', () => {
  it('resumes at the reset time when the CLI gave one', () => {
    const resetAt = new Date('2030-01-01T09:30:00.000Z');
    expect(nextResume('a1', resetAt, 0, start)).toEqual({
      agentId: 'a1',
      at: '2030-01-01T09:30:00.000Z',
      attempt: 0,
    });
  });

  it('backs off 1, 2, 4, 8, 15, 15… minutes when the reset time is unknown', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 2, 4, 8, 15]);
    const delays = [0, 1, 2, 3, 4, 5, 9].map(
      (attempt) => (Date.parse(nextResume('a1', undefined, attempt, start).at) - +start) / MINUTE,
    );
    expect(delays).toEqual([1, 2, 4, 8, 15, 15, 15]);
  });

  it('takes a reset time already past for an unknown one', () => {
    const past = new Date('2030-01-01T08:00:00.000Z');
    expect(nextResume('a1', past, 1, start).at).toBe('2030-01-01T09:02:00.000Z');
    expect(nextResume('a1', start, 0, start).at).toBe('2030-01-01T09:01:00.000Z');
  });
});

describe('AutoResume', () => {
  let due: ScheduledResume[];
  let resumes: AutoResume;

  beforeEach(() => {
    vi.useFakeTimers({ now: start });
    due = [];
    resumes = new AutoResume({ clock, onDue: (resume) => due.push(resume) });
  });

  afterEach(() => {
    resumes.dispose();
    vi.useRealTimers();
  });

  /** A rate limit on `current`, then the change saved, as the agent manager does it. */
  const limit = (current: Agent, resetAt?: Date) => {
    const planned = resumes.plan(current, resetAt);
    const next = planned ? { ...current, scheduledResume: planned } : current;
    resumes.sync(next);
    return next;
  };

  it('fires at the reset time, not before', () => {
    const limited = limit(agent(), new Date('2030-01-01T09:30:00.000Z'));
    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(due).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(due).toEqual([limited.scheduledResume]);
  });

  it('grows the backoff at each new limit until the turn ends', () => {
    let current = limit(agent());
    expect(current.scheduledResume?.attempt).toBe(0);
    vi.advanceTimersByTime(MINUTE);
    current = limit({ ...current, scheduledResume: null });
    expect(current.scheduledResume).toMatchObject({ attempt: 1, at: '2030-01-01T09:03:00.000Z' });
    resumes.forget('a1');
    expect(limit(agent()).scheduledResume?.attempt).toBe(0);
  });

  it('plans nothing more while a resume is already scheduled (a banner shown again)', () => {
    const limited = limit(agent());
    expect(resumes.plan(limited)).toBeNull();
    vi.advanceTimersByTime(MINUTE);
    expect(due).toHaveLength(1);
  });

  it('cancels the resume once the agent has none any more (Annuler, Reprendre, Relancer)', () => {
    limit(agent());
    resumes.sync(agent({ scheduledResume: null }));
    vi.advanceTimersByTime(20 * MINUTE);
    expect(due).toEqual([]);
  });

  it('cancels it when the agent is closed', () => {
    limit(agent());
    resumes.forget('a1');
    vi.advanceTimersByTime(20 * MINUTE);
    expect(due).toEqual([]);
  });

  it('cancels it when the CLI takes a prompt again (UserPromptSubmit, quota_auto_resume_fired)', () => {
    const limited = limit(agent());
    const resumed = applySignal(limited, { type: 'prompt-submitted' });
    expect(resumed).toMatchObject({ state: 'working', lastError: null, scheduledResume: null });
    resumes.sync(resumed);
    vi.advanceTimersByTime(20 * MINUTE);
    expect(due).toEqual([]);
  });

  it('keeps it when the process exits after the rate limit', () => {
    const limited = limit(agent());
    resumes.sync({ ...limited, lastError: { code: 1, kind: 'rate-limit', message: 'x' } });
    vi.advanceTimersByTime(MINUTE);
    expect(due).toHaveLength(1);
  });

  it('arms a resume read back from disk, at once when its time has passed', () => {
    const saved = { agentId: 'a1', at: '2030-01-01T08:59:00.000Z', attempt: 2 };
    resumes.sync(agent({ scheduledResume: saved }));
    vi.advanceTimersByTime(0);
    expect(due).toEqual([saved]);
  });

  it('waits past the longest timer Node allows for a reset far away', () => {
    const far = new Date(+start + 40 * 24 * 60 * MINUTE);
    limit(agent(), far);
    vi.advanceTimersByTime(2 ** 31);
    expect(due).toEqual([]);
    vi.advanceTimersByTime(+far - +start - 2 ** 31);
    expect(due).toHaveLength(1);
  });

  it('keeps the timer of a resume saved again unchanged', () => {
    const limited = limit(agent());
    vi.advanceTimersByTime(MINUTE / 2);
    resumes.sync(limited);
    vi.advanceTimersByTime(MINUTE / 2);
    expect(due).toHaveLength(1);
  });
});
