import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { IpcFailure } from '../../shared/ipc';
import { MAX_RECENT_PROJECTS, type RecentProject, type Workspace } from '../../shared/model';
import type { GitService } from '../git/git-service';
import type { AppState, Stores } from '../persistence/store';

// US1 — repositories opened as workspaces, recent projects, availability (FR-003…FR-005).

type Options = {
  git: GitService;
  stores: Stores;
  now?: () => Date;
  onStatus?: (event: { id: string; status: Workspace['status'] }) => void;
};

/** Stable id: hash of the repository's real path (data-model Workspace.id). */
export const workspaceId = (repoRoot: string) =>
  createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);

const isDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

async function countKeptWorktrees(repo: string) {
  try {
    const entries = await readdir(join(repo, '.worktrees'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

export class WorkspaceService {
  private readonly open_ = new Map<string, Workspace>();
  private readonly git: GitService;
  private readonly stores: Stores;
  private readonly now: () => Date;
  private readonly onStatus: NonNullable<Options['onStatus']>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly watchers = new Map<string, FSWatcher>();
  private watching = false;

  constructor({ git, stores, now = () => new Date(), onStatus = () => undefined }: Options) {
    this.git = git;
    this.stores = stores;
    this.now = now;
    this.onStatus = onStatus;
  }

  list(): Workspace[] {
    return [...this.open_.values()];
  }

  get(id: string): Workspace | undefined {
    return this.open_.get(id);
  }

  async open(path: string): Promise<Workspace> {
    if (!(await this.git.isRepo(path))) {
      throw new IpcFailure('NOT_A_REPO', `« ${basename(path)} » n’est pas un dépôt Git.`);
    }
    const root = await this.git.repoRoot(path);
    const id = workspaceId(root);
    if (this.open_.has(id)) {
      throw new IpcFailure('ALREADY_OPEN', 'Ce dépôt est déjà ouvert.', id);
    }

    const saved = await this.stores.workspace(id).read();
    const workspace: Workspace = {
      agents: [],
      freeTerminals: [],
      quickLaunchCounters: { freeTerminal: 0 },
      permissionOverride: null,
      ...saved,
      id,
      path: root,
      name: basename(root),
      mainBranch: await this.git.currentBranch(root),
      lastOpenedAt: this.now().toISOString(),
      status: 'available',
    };
    this.open_.set(id, workspace);
    this.watchFolder(workspace);
    await this.stores.workspace(id).write(workspace);
    await this.updateAppState((state) => ({
      ...state,
      openWorkspaces: [...state.openWorkspaces.filter((p) => p !== root), root],
    }));
    await this.remember(workspace);
    return workspace;
  }

  async initRepo(path: string): Promise<Workspace> {
    await this.git.initRepo(path);
    return this.open(path);
  }

  async close(id: string): Promise<void> {
    const workspace = this.open_.get(id);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    this.open_.delete(id);
    this.unwatchFolder(id);
    await this.updateAppState((state) => ({
      ...state,
      openWorkspaces: state.openWorkspaces.filter((p) => p !== workspace.path),
    }));
    await this.remember(workspace);
  }

  async recents(): Promise<RecentProject[]> {
    return (await this.stores.state.read()).recents;
  }

  /** Reopens the workspaces that were open when the app quit (FR-005, FR-038). */
  async restore(): Promise<Workspace[]> {
    const { openWorkspaces } = await this.stores.state.read();
    for (const path of openWorkspaces) {
      const id = workspaceId(path);
      const saved = await this.stores.workspace(id).read();
      const available = (await isDirectory(path)) && (await this.git.isRepo(path));
      this.open_.set(id, {
        agents: [],
        freeTerminals: [],
        quickLaunchCounters: { freeTerminal: 0 },
        permissionOverride: null,
        mainBranch: '',
        lastOpenedAt: this.now().toISOString(),
        ...saved,
        id,
        path,
        name: basename(path),
        status: available ? 'available' : 'unavailable',
      });
    }
    return this.list();
  }

  /** A workspace whose folder disappears becomes unavailable (spec edge case, T121). */
  async checkAvailability(): Promise<void> {
    for (const workspace of this.list()) {
      const status: Workspace['status'] = (await isDirectory(workspace.path))
        ? 'available'
        : 'unavailable';
      if (status === workspace.status) continue;
      const updated = { ...workspace, status };
      this.open_.set(workspace.id, updated);
      await this.stores.workspace(workspace.id).write(updated);
      this.onStatus({ id: workspace.id, status });
    }
  }

  /**
   * Watches each workspace folder's parent to react at once when it is removed or renamed; the
   * periodic check stays as a safety net (watchers can miss events or fail to start).
   */
  startWatching(intervalMs: number): void {
    this.dispose();
    this.watching = true;
    for (const workspace of this.list()) this.watchFolder(workspace);
    this.timer = setInterval(() => {
      void this.checkAvailability();
    }, intervalMs);
  }

  dispose(): void {
    this.watching = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const id of [...this.watchers.keys()]) this.unwatchFolder(id);
  }

  private watchFolder(workspace: Workspace) {
    if (!this.watching || this.watchers.has(workspace.id)) return;
    const name = basename(workspace.path);
    try {
      const watcher = watch(dirname(workspace.path), (_event, filename) => {
        if (filename === null || filename === name) void this.checkAvailability();
      });
      watcher.on('error', () => {
        this.unwatchFolder(workspace.id);
      });
      this.watchers.set(workspace.id, watcher);
    } catch {
      // The parent folder may be gone or unreadable: the periodic check still covers it.
    }
  }

  private unwatchFolder(id: string) {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  private async remember(workspace: Workspace) {
    const recent: RecentProject = {
      path: workspace.path,
      name: workspace.name,
      branch: workspace.mainBranch,
      keptWorktrees: await countKeptWorktrees(workspace.path),
      lastOpenedAt: workspace.lastOpenedAt,
    };
    await this.updateAppState((state) => ({
      ...state,
      recents: [recent, ...state.recents.filter((r) => r.path !== recent.path)]
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
        .slice(0, MAX_RECENT_PROJECTS),
    }));
  }

  private async updateAppState(update: (state: AppState) => AppState) {
    await this.stores.state.write(update(await this.stores.state.read()));
  }
}
