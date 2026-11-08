import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { IpcFailure } from '../../shared/ipc';
import {
  MAX_RECENT_PROJECTS,
  workspaceSchema,
  type RecentProject,
  type Workspace,
} from '../../shared/model';
import type { GitService } from '../git/git-service';
import type { AppState, Stores } from '../persistence/store';
import { defaultDeliverySettings } from '../../shared/delivery';
import { DEFAULT_TEST_PATHS } from '../../shared/model';

// US1 — repositories opened as workspaces, recent projects, availability (FR-003…FR-005).

type Options = {
  git: GitService;
  stores: Stores;
  now?: () => Date;
  onStatus?: (event: { id: string; status: Workspace['status'] }) => void;
  /** The main branch of a workspace changed once origin answered (never awaited at opening). */
  onMainBranch?: (id: string, mainBranch: string) => void;
};

const WATCH_DEBOUNCE_MS = 50;

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
  private readonly onMainBranch: NonNullable<Options['onMainBranch']>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly watchers = new Map<string, FSWatcher>();
  private watching = false;
  private pendingCheck: ReturnType<typeof setTimeout> | undefined;

  constructor({
    git,
    stores,
    now = () => new Date(),
    onStatus = () => undefined,
    onMainBranch = () => undefined,
  }: Options) {
    this.git = git;
    this.stores = stores;
    this.now = now;
    this.onStatus = onStatus;
    this.onMainBranch = onMainBranch;
  }

  list(): Workspace[] {
    return [...this.open_.values()];
  }

  get(id: string): Workspace | undefined {
    return this.open_.get(id);
  }

  /** Whether a permission level was chosen for the workspace: its own, or the global one (FR-012). */
  async hasPermissionChoice(id: string): Promise<boolean> {
    return (
      this.get(id)?.permissionOverride != null ||
      (await this.stores.state.read()).permission != null
    );
  }

  /** Changes an open workspace and saves it, keeping memory and disk in step. */
  async update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace> {
    const workspace = this.open_.get(id);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    // Validated before it replaces the open workspace: a change that cannot be saved must not
    // stay in memory, or every later save of this workspace would fail too (T146).
    const updated = change(workspace);
    workspaceSchema.parse(updated);
    this.open_.set(id, updated);
    await this.stores.workspace(id).write(updated);
    return updated;
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
    // The best value known now: opening never waits for the network.
    const known = await this.git.knownDefaultBranch(root);
    const workspace: Workspace = {
      agents: [],
      freeTerminals: [],
      quickLaunchCounters: { freeTerminal: 0 },
      permissionOverride: null,
      testCommand: null,
      integrationRequests: [],
      delivery: defaultDeliverySettings(),
      deliveries: [],
      roleProfiles: {},
      issues: [],
      loops: [],
      testPaths: [...DEFAULT_TEST_PATHS],
      publishRequests: [],
      exchanges: { messages: [], escalations: [] },
      ...saved,
      id,
      path: root,
      name: basename(root),
      mainBranch: known.branch,
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
    if (!known.settled) this.resolveWithOrigin(id, root);
    return workspace;
  }

  /**
   * Origin may know a better main branch than the refs here: asked in the background, the
   * workspace is changed (and told) only if it answers something else.
   */
  private resolveWithOrigin(id: string, path: string): void {
    void this.git
      .remoteDefaultBranch(path)
      .then(async (branch) => {
        const current = this.open_.get(id);
        if (branch === null || !current || current.mainBranch === branch) return;
        const updated = await this.update(id, (ws) => ({ ...ws, mainBranch: branch }));
        await this.remember(updated);
        this.onMainBranch(id, branch);
      })
      .catch(() => undefined);
  }

  /** Worktrees start from the committed base branch: uncommitted changes stay out (T122). */
  async hasLocalChanges(id: string): Promise<boolean> {
    const workspace = this.get(id);
    if (!workspace) throw new IpcFailure('NOT_FOUND', 'Workspace inconnu.');
    return this.git.hasUncommittedChanges(workspace.path);
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
    const resolving: { id: string; path: string }[] = [];
    for (const path of openWorkspaces) {
      const id = workspaceId(path);
      const saved = await this.stores.workspace(id).read();
      const available = (await isDirectory(path)) && (await this.git.isRepo(path));
      // The main branch is the one of origin, whatever was saved (and whatever the root is on):
      // the best value known now, origin being asked in the background.
      const known = available ? await this.git.knownDefaultBranch(path) : undefined;
      const mainBranch = known?.branch ?? saved?.mainBranch ?? '';
      if (known && !known.settled) resolving.push({ id, path });
      this.open_.set(id, {
        agents: [],
        freeTerminals: [],
        quickLaunchCounters: { freeTerminal: 0 },
        permissionOverride: null,
        testCommand: null,
        integrationRequests: [],
        delivery: defaultDeliverySettings(),
        deliveries: [],
        roleProfiles: {},
        issues: [],
        loops: [],
        testPaths: [...DEFAULT_TEST_PATHS],
        publishRequests: [],
        exchanges: { messages: [], escalations: [] },
        lastOpenedAt: this.now().toISOString(),
        ...saved,
        mainBranch,
        id,
        path,
        name: basename(path),
        status: available ? 'available' : 'unavailable',
      });
    }
    for (const { id, path } of resolving) this.resolveWithOrigin(id, path);
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
    if (this.pendingCheck) clearTimeout(this.pendingCheck);
    this.pendingCheck = undefined;
    for (const id of [...this.watchers.keys()]) this.unwatchFolder(id);
  }

  private watchFolder(workspace: Workspace) {
    if (!this.watching || this.watchers.has(workspace.id)) return;
    try {
      // Any change in the parent: a rename may only report the new name (macOS FSEvents).
      const watcher = watch(dirname(workspace.path), () => {
        this.scheduleCheck();
      });
      watcher.on('error', () => {
        this.unwatchFolder(workspace.id);
      });
      this.watchers.set(workspace.id, watcher);
    } catch {
      // The parent folder may be gone or unreadable: the periodic check still covers it.
    }
  }

  /** Coalesces a burst of watcher events into one check. */
  private scheduleCheck() {
    if (this.pendingCheck) return;
    this.pendingCheck = setTimeout(() => {
      this.pendingCheck = undefined;
      void this.checkAvailability();
    }, WATCH_DEBOUNCE_MS);
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
