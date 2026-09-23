export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
const realClock: Clock = { now: Date.now, setTimeout, clearTimeout };
export class AutoResumeScheduler {
  private jobs = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private clock: Clock = realClock) {}
  schedule(agentId: string, attempt: number, run: () => void, resetAt?: Date) {
    this.cancel(agentId);
    const minutes = [1, 2, 4, 8, 15][Math.min(attempt, 4)] ?? 15;
    const at = resetAt?.getTime() ?? this.clock.now() + minutes * 60000;
    this.jobs.set(
      agentId,
      this.clock.setTimeout(
        () => {
          this.jobs.delete(agentId);
          run();
        },
        Math.max(0, at - this.clock.now()),
      ),
    );
    return { agentId, at: new Date(at).toISOString(), attempt };
  }
  cancel(agentId: string) {
    const job = this.jobs.get(agentId);
    if (job) this.clock.clearTimeout(job);
    this.jobs.delete(agentId);
  }
}
