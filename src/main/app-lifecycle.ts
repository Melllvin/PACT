type QuitEvent = { preventDefault(): void };
type QuittingApp = {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown;
  quit(): void;
};

type Options = {
  app: QuittingApp;
  /** Agents whose process runs now. */
  activeAgents: () => number;
  /** Asks the user; true quits. */
  confirm: (count: number) => Promise<boolean>;
  /** Stops every agent, free terminal and PTY; awaited before the app exits. */
  shutdown: () => Promise<void>;
  /** e2e runs: no one is there to answer. */
  skipConfirm?: boolean;
  /** Past this, the app quits even if a stop has not finished. */
  deadlineMs?: number;
};

const DEADLINE_MS = 5000;

/**
 * T110: holds the quit while agents are active until the user confirms, then lets the app exit
 * only once every PTY is stopped. Agent states stay saved as they are (FR-038).
 */
export function guardQuit({
  app,
  activeAgents,
  confirm,
  shutdown,
  skipConfirm,
  deadlineMs = DEADLINE_MS,
}: Options): void {
  let phase: 'open' | 'busy' | 'done' = 'open';
  app.on('before-quit', (event) => {
    if (phase === 'done') return;
    event.preventDefault();
    if (phase === 'busy') return;
    phase = 'busy';
    void (async () => {
      const count = activeAgents();
      if (count > 0 && !skipConfirm && !(await confirm(count))) {
        phase = 'open';
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
      });
      await Promise.race([shutdown().catch(() => undefined), deadline]);
      clearTimeout(timer);
      phase = 'done';
      app.quit();
    })();
  });
}

/** The quit question of T110, Annuler by default. */
export function quitQuestion(count: number) {
  return {
    type: 'question' as const,
    message:
      count === 1
        ? '1 agent est actif. Quitter PACT ?'
        : `${String(count)} agents sont actifs. Quitter PACT ?`,
    detail: 'Leurs processus seront arrêtés ; leur état reste enregistré.',
    buttons: ['Quitter', 'Annuler'],
    defaultId: 1,
    cancelId: 1,
  };
}
