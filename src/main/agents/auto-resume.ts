import type { Agent, ScheduledResume } from '../../shared/model';

// US7, FR-036 — the resume PACT schedules without asking after a rate limit (data-model.md
// « ScheduledResume »): at the reset time when the CLI gives one, otherwise after a backoff.

/** Minutes before each new try when the reset time is unknown; the last one repeats. */
export const BACKOFF_MINUTES = [1, 2, 4, 8, 15] as const;

/** The longest delay a Node timer takes; a later one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MINUTE_MS = 60_000;

export type Clock = {
  now(): Date;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
};

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/** A reset time already past is no better than none: the backoff applies. */
export function nextResume(
  agentId: string,
  resetAt: Date | undefined,
  attempt: number,
  now: Date,
): ScheduledResume {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)] ?? 15;
  const at = resetAt && resetAt > now ? resetAt : new Date(+now + minutes * MINUTE_MS);
  return { agentId, at: at.toISOString(), attempt };
}

type Armed = { resume: ScheduledResume; timer: unknown };

/**
 * One timer per scheduled resume. The agent is the reference: `sync` after each saved change
 * arms the timer of its `scheduledResume`, or clears it once there is none (Annuler, Reprendre,
 * Relancer, a new prompt).
 */
export class AutoResume {
  private readonly clock: Clock;
  private readonly onDue: (resume: ScheduledResume) => void;
  private readonly armed = new Map<string, Armed>();
  /** Tries since the last finished turn: the backoff grows until then. */
  private readonly attempts = new Map<string, number>();

  constructor({
    clock = systemClock,
    onDue,
  }: {
    clock?: Clock;
    onDue: (r: ScheduledResume) => void;
  }) {
    this.clock = clock;
    this.onDue = onDue;
  }

  /** The resume after a rate limit of `agent`, or null when one is already scheduled. */
  plan(agent: Agent, resetAt?: Date): ScheduledResume | null {
    if (agent.scheduledResume) return null;
    const attempt = this.attempts.get(agent.id) ?? 0;
    this.attempts.set(agent.id, attempt + 1);
    return nextResume(agent.id, resetAt, attempt, this.clock.now());
  }

  sync(agent: Agent): void {
    const resume = agent.scheduledResume;
    const armed = this.armed.get(agent.id);
    if (!resume) {
      this.disarm(agent.id);
      return;
    }
    if (armed && armed.resume.at === resume.at && armed.resume.attempt === resume.attempt) return;
    this.disarm(agent.id);
    this.arm(resume);
  }

  /** The turn ended or the user took over: no resume, and the backoff starts again. */
  forget(agentId: string): void {
    this.disarm(agentId);
    this.attempts.delete(agentId);
  }

  dispose(): void {
    for (const agentId of [...this.armed.keys()]) this.disarm(agentId);
    this.attempts.clear();
  }

  private arm(resume: ScheduledResume) {
    const delay = Math.max(0, Date.parse(resume.at) - +this.clock.now());
    const timer = this.clock.setTimeout(
      () => {
        this.armed.delete(resume.agentId);
        // A reset beyond the longest timer: wait again for what is left.
        if (Date.parse(resume.at) > +this.clock.now()) this.arm(resume);
        else this.onDue(resume);
      },
      Math.min(delay, MAX_TIMER_MS),
    );
    this.armed.set(resume.agentId, { resume, timer });
  }

  private disarm(agentId: string) {
    const armed = this.armed.get(agentId);
    if (!armed) return;
    this.clock.clearTimeout(armed.timer);
    this.armed.delete(agentId);
  }
}
