import type { PactApi } from '../../shared/ipc';

/** The part of an xterm Terminal the registry uses (xterm-factory.ts builds the real one). */
export type TerminalLike = {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  open(parent: HTMLElement): void;
  write(data: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  fit(): void;
  focus(): void;
  dispose(): void;
};

export type TerminalRegistry = {
  /** Shows the terminal `termId` in `element`; returns the function that takes it out again. */
  attach(termId: string, element: HTMLElement): () => void;
  dispose(termId: string): void;
};

type Entry = { terminal: TerminalLike | undefined; pending: string[] };

/**
 * One terminal per PTY, kept alive between tiles and moved in the DOM (research.md R2). Output that
 * arrives before its tile is shown is kept and written on the first attach.
 */
export function createTerminalRegistry(api: PactApi, create: () => TerminalLike): TerminalRegistry {
  const entries = new Map<string, Entry>();
  const entry = (termId: string) => {
    let found = entries.get(termId);
    if (!found) {
      found = { terminal: undefined, pending: [] };
      entries.set(termId, found);
    }
    return found;
  };
  // A terminal that has just exited refuses input and resizing: nothing to report.
  const ignore = () => undefined;

  api.on('term:data', ({ termId, data }) => {
    const found = entry(termId);
    if (found.terminal) found.terminal.write(data);
    else found.pending.push(data);
  });

  const fit = (termId: string, terminal: TerminalLike) => {
    terminal.fit();
    void api
      .invoke('term:resize', { termId, cols: terminal.cols, rows: terminal.rows })
      .catch(ignore);
  };

  return {
    attach(termId, element) {
      const found = entry(termId);
      let terminal = found.terminal;
      if (!terminal) {
        terminal = create();
        found.terminal = terminal;
        terminal.open(element);
        // Registered once per terminal: attaching again must not send every keystroke twice.
        terminal.onData((data) => {
          void api.invoke('term:write', { termId, data }).catch(ignore);
        });
        for (const data of found.pending) terminal.write(data);
        found.pending = [];
      } else if (terminal.element) {
        element.appendChild(terminal.element);
      }
      const shown = terminal;
      fit(termId, shown);
      const observer =
        typeof ResizeObserver === 'undefined'
          ? undefined
          : new ResizeObserver(() => {
              fit(termId, shown);
            });
      observer?.observe(element);
      return () => {
        observer?.disconnect();
      };
    },

    dispose(termId) {
      entries.get(termId)?.terminal?.dispose();
      entries.delete(termId);
    },
  };
}
