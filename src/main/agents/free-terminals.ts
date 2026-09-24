import { randomUUID } from 'node:crypto';
import { IpcFailure } from '../../shared/ipc';
import type { FreeTerminal, Workspace } from '../../shared/model';
import { findExecutable } from '../env/resolve-command';
import type { PtyManager } from '../pty/pty-manager';
import type { ResolvedEnv } from './adapters/types';

// FR-025 — « Terminal libre »: the user's shell at the root of the main repository.

type WorkspaceAccess = {
  get(id: string): Workspace | undefined;
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

type Find = (
  command: string,
  env: ResolvedEnv,
  platform: NodeJS.Platform,
) => Promise<string | null>;

/** `$SHELL` as a login shell on macOS and Linux; `pwsh`, else `powershell.exe`, on Windows. */
export async function freeTerminalShell(
  env: ResolvedEnv,
  platform: NodeJS.Platform,
  find: Find = findExecutable,
): Promise<{ file: string; args: string[] }> {
  if (platform === 'win32') {
    return { file: (await find('pwsh', env, platform)) ?? 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'), args: ['-l'] };
}

type Options = {
  workspaces: WorkspaceAccess;
  pty: PtyManager;
  resolveEnv: () => Promise<ResolvedEnv>;
  platform: NodeJS.Platform;
};

export class FreeTerminals {
  private readonly workspaces: WorkspaceAccess;
  private readonly pty: PtyManager;
  private readonly resolveEnv: () => Promise<ResolvedEnv>;
  private readonly platform: NodeJS.Platform;
  /** Terminal id → workspace id, for the terminals this instance started. */
  private readonly running = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor({ workspaces, pty, resolveEnv, platform }: Options) {
    this.workspaces = workspaces;
    this.pty = pty;
    this.resolveEnv = resolveEnv;
    this.platform = platform;
    this.unsubscribe = pty.onExit((id) => {
      void this.exited(id);
    });
  }

  async open(workspaceId: string, count: number): Promise<FreeTerminal[]> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    if (count === 0) return [];
    const env = await this.resolveEnv();
    const { file } = await freeTerminalShell(env, this.platform);
    const opened = Array.from({ length: count }, (): FreeTerminal => ({
      id: randomUUID(),
      workspaceId,
      cwd: workspace.path,
      shell: file,
    }));
    await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      freeTerminals: [...ws.freeTerminals, ...opened],
    }));
    for (const terminal of opened) await this.start(terminal, env);
    return opened;
  }

  /** Shells do not survive a restart: the saved terminals get a new one (FR-038). */
  async restore(workspaceId: string): Promise<void> {
    const saved = this.workspaces.get(workspaceId)?.freeTerminals ?? [];
    if (saved.length === 0) return;
    const env = await this.resolveEnv();
    for (const terminal of saved) {
      if (!this.pty.has(terminal.id)) await this.start(terminal, env);
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    const ids = [...this.running.keys()];
    this.running.clear();
    await Promise.all(ids.map((id) => this.pty.kill(id)));
  }

  private async start(terminal: FreeTerminal, env: ResolvedEnv) {
    const { args } = await freeTerminalShell(env, this.platform);
    const defined: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) if (value !== undefined) defined[name] = value;
    this.running.set(terminal.id, terminal.workspaceId);
    this.pty.start(terminal.id, { file: terminal.shell, args, cwd: terminal.cwd, env: defined });
  }

  /** The user left the shell (`exit`): the terminal goes away. */
  private async exited(id: string) {
    const workspaceId = this.running.get(id);
    if (workspaceId === undefined) return;
    this.running.delete(id);
    if (!this.workspaces.get(workspaceId)) return;
    await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      freeTerminals: ws.freeTerminals.filter((terminal) => terminal.id !== id),
    }));
  }
}
