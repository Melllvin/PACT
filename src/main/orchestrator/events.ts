import type { OrchestratorEvent } from '../../shared/orchestrator';

// 003 research R5 — what an orchestrator waits for: the events of its agents, kept between two
// waits so that none is lost, and one wait at a time.

const MAX_EVENTS = 100;

export type WaitResult = { events: OrchestratorEvent[]; timedOut: boolean; replaced?: true };

type Waiting = {
  agentIds: readonly string[] | undefined;
  resolve: (result: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class EventQueue {
  private events: OrchestratorEvent[] = [];
  private waiting: Waiting | undefined;

  push(event: OrchestratorEvent): void {
    this.events = [...this.events, event].slice(-MAX_EVENTS);
    if (this.waiting) this.deliver(this.waiting);
  }

  /** The events of `agentIds` (all agents when undefined), or none once `timeoutMs` is over. */
  wait(agentIds: readonly string[] | undefined, timeoutMs: number): Promise<WaitResult> {
    this.end({ events: [], timedOut: false, replaced: true });
    return new Promise((resolve) => {
      const waiting: Waiting = {
        agentIds,
        resolve,
        timer: setTimeout(() => {
          this.end({ events: [], timedOut: true });
        }, timeoutMs),
      };
      this.waiting = waiting;
      this.deliver(waiting);
    });
  }

  /** The orchestrator is gone or its role withdrawn: its wait ends empty. */
  close(): void {
    this.end({ events: [], timedOut: false, replaced: true });
    this.events = [];
  }

  /** Hands over the matching events, if any, and ends the wait. */
  private deliver(waiting: Waiting) {
    const wanted = (event: OrchestratorEvent) =>
      waiting.agentIds === undefined || waiting.agentIds.includes(event.agentId);
    const matching = this.events.filter(wanted);
    if (matching.length === 0) return;
    this.events = this.events.filter((event) => !wanted(event));
    this.end({ events: matching, timedOut: false });
  }

  private end(result: WaitResult) {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }
}
