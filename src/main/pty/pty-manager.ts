import * as nodePty from 'node-pty';

// research.md R2 — one pseudo-terminal per agent or free terminal, in the main process.

const FRAME_MS = 16;
const HISTORY_CHARS = 1_000_000;
/** Trim the history in steps so a burst of small chunks never copies 1 MB per chunk. */
const HISTORY_SLACK = 256_000;
const KILL_TIMEOUT_MS = 3000;

export type PtySpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};
type Disposable = { dispose(): void };

/** The part of node-pty's IPty that PACT relies on (injectable for tests). */
export interface PtyProcess {
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type PtySpawn = (
  file: string,
  args: string[] | string,
  options: PtySpawnOptions,
) => PtyProcess;

export type PtyStartSpec = {
  file: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Arguments already escaped for cmd.exe (see resolve-command): passed as one raw string. */
  windowsVerbatimArguments?: boolean;
};

type Session = {
  pty: PtyProcess;
  pending: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  exited: Promise<void>;
};

const defaultSpawn: PtySpawn = (file, args, options) =>
  nodePty.spawn(file, args, { name: 'xterm-256color', ...options });

export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  private readonly histories = new Map<string, string>();
  private readonly dataListeners = new Set<(id: string, data: string) => void>();
  private readonly exitListeners = new Set<(id: string, code: number) => void>();
  private readonly spawn: PtySpawn;
  private readonly platform: NodeJS.Platform;

  constructor({ spawn = defaultSpawn, platform = process.platform } = {}) {
    this.spawn = spawn;
    this.platform = platform;
  }

  start(id: string, spec: PtyStartSpec): void {
    if (this.sessions.has(id)) throw new Error(`Terminal ${id} is already running`);
    const args =
      this.platform === 'win32' && spec.windowsVerbatimArguments ? spec.args.join(' ') : spec.args;
    const pty = this.spawn(spec.file, args, {
      cwd: spec.cwd,
      env: spec.env,
      cols: spec.cols ?? 80,
      rows: spec.rows ?? 24,
    });
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const session: Session = { pty, pending: '', timer: undefined, exited };
    this.sessions.set(id, session);
    // A resumed or restarted agent keeps its earlier output for « Journal ».
    if (!this.histories.has(id)) this.histories.set(id, '');

    pty.onData((data) => {
      this.remember(id, data);
      session.pending += data;
      session.timer ??= setTimeout(() => {
        this.flush(id, session);
      }, FRAME_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.flush(id, session);
      this.sessions.delete(id);
      for (const listener of this.exitListeners) listener(id, exitCode);
      markExited();
    });
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(cols, rows);
  }

  /** Last ~1 MB of output, kept after the process exited (« Journal »). */
  history(id: string): string {
    return (this.histories.get(id) ?? '').slice(-HISTORY_CHARS);
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.pty.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, KILL_TIMEOUT_MS);
    });
    const outcome = await Promise.race([session.exited, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout' && this.platform !== 'win32') {
      session.pty.kill('SIGKILL');
      await session.exited;
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.kill(id)));
  }

  onData(listener: (id: string, data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (id: string, code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private remember(id: string, data: string) {
    const history = (this.histories.get(id) ?? '') + data;
    this.histories.set(
      id,
      history.length > HISTORY_CHARS + HISTORY_SLACK ? history.slice(-HISTORY_CHARS) : history,
    );
  }

  private flush(id: string, session: Session) {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    for (const listener of this.dataListeners) listener(id, data);
  }
}
