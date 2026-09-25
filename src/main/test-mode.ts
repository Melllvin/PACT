import type { Clock } from './agents/auto-resume';

type PathSetter = { setPath(name: 'userData', path: string): void };

/** In e2e runs (PACT_TEST_MODE=1), isolates app data in the directory chosen by the harness. */
export function applyTestMode(app: PathSetter, env: NodeJS.ProcessEnv): void {
  if (env.PACT_TEST_MODE !== '1' || !env.PACT_USER_DATA_DIR) return;
  app.setPath('userData', env.PACT_USER_DATA_DIR);
}

type Timer = { at: number; run: () => void };

/** A clock only the e2e harness moves (`advanceTo`), for the scheduled resumes of US7 (T106). */
export class ManualClock implements Clock {
  private current: number;
  private readonly timers = new Set<Timer>();

  constructor(start: Date) {
    this.current = +start;
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(run: () => void, ms: number): unknown {
    const timer = { at: this.current + ms, run };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as Timer);
  }

  /** Moves the time to `iso` and runs the timers due by then. */
  advanceTo(iso: string): void {
    this.current = Date.parse(iso);
    for (const timer of [...this.timers]) {
      if (timer.at > this.current) continue;
      this.timers.delete(timer);
      timer.run();
    }
  }
}

/** In e2e runs with PACT_TEST_NOW, the time starts there and moves only when the harness says. */
export function testClock(env: NodeJS.ProcessEnv): ManualClock | undefined {
  if (env.PACT_TEST_MODE !== '1' || !env.PACT_TEST_NOW) return undefined;
  return new ManualClock(new Date(env.PACT_TEST_NOW));
}
