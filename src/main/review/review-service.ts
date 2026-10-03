import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { IpcFailure, type IpcEvent } from '../../shared/ipc';
import type { Agent, Workspace } from '../../shared/model';
import { seenBlob, type FileDiff, type ReviewSnapshot } from '../../shared/review';
import type { GitService } from '../git/git-service';

// 002 US1 — an agent's changes against main, followed while the worktree changes
// (research R1–R3), with the files marked « vu » kept per agent (R9, FR-009, FR-011).

type WorkspaceAccess = {
  get(id: string): Workspace | undefined;
  list(): Workspace[];
  update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
};

/** Calls `onChange` for any change under `dir`; returns the function that stops watching. */
export type Watch = (dir: string, onChange: (file: string | null) => void) => () => void;

type Options = {
  git: Pick<
    GitService,
    | 'snapshot'
    | 'mergeBase'
    | 'changedFiles'
    | 'fileDiff'
    | 'revParse'
    | 'currentBranch'
    | 'diffBlobs'
  >;
  workspaces: WorkspaceAccess;
  onChanged?: (snapshot: ReviewSnapshot) => void;
  onPending?: (event: IpcEvent<'review:pending'>) => void;
  watch?: Watch;
  /** Bursts of file events are read once, after this quiet time (R3). */
  debounceMs?: number;
  /** A missed event is caught up by a check this often (R3). */
  safetyMs?: number;
};

type Followed = {
  stop: () => void;
  timer?: ReturnType<typeof setTimeout>;
  safety: ReturnType<typeof setInterval>;
};

const NO_COMMIT = '0'.repeat(40);
const READY: Agent['state'][] = ['done', 'awaiting-prompt'];

/** `fs.watch` recursive, without the `.git` folder or file (R3). */
const watchRecursive: Watch = (dir, onChange) => {
  try {
    const watcher = fsWatch(dir, { recursive: true }, (_event, file) => {
      const name = file?.toString().replaceAll('\\', '/') ?? null;
      if (name !== null && (name === '.git' || name.startsWith('.git/'))) return;
      onChange(name);
    });
    watcher.on('error', () => undefined);
    return () => {
      watcher.close();
    };
  } catch {
    // The worktree may be gone: the safety net still checks it.
    return () => undefined;
  }
};

const isDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export class ReviewService {
  private readonly git: Options['git'];
  private readonly workspaces: WorkspaceAccess;
  private readonly onChanged: NonNullable<Options['onChanged']>;
  private readonly onPending: NonNullable<Options['onPending']>;
  private readonly watch: Watch;
  private readonly debounceMs: number;
  private readonly safetyMs: number;
  private readonly followed = new Map<string, Followed>();
  /** The last snapshot of each agent, as announced. */
  private readonly snapshots = new Map<string, ReviewSnapshot>();
  /** Reviews asked for and not closed since, so a close during `open` wins. */
  private readonly wanted = new Set<string>();
  /** The latest `updatePending` of each workspace: an older one ending last says nothing. */
  private readonly pendingRuns = new Map<string, number>();

  constructor(options: Options) {
    this.git = options.git;
    this.workspaces = options.workspaces;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onPending = options.onPending ?? (() => undefined);
    this.watch = options.watch ?? watchRecursive;
    this.debounceMs = options.debounceMs ?? 300;
    this.safetyMs = options.safetyMs ?? 5000;
  }

  /** Builds the review and follows the worktree until `close` (FR-001, FR-010). */
  async open(agentId: string): Promise<ReviewSnapshot> {
    const { agent } = this.find(agentId);
    this.wanted.add(agentId);
    const snapshot = await this.compute(agentId);
    this.snapshots.set(agentId, snapshot);
    if (this.wanted.has(agentId) && !this.followed.has(agentId)) {
      const followed: Followed = {
        stop: this.watch(agent.worktreePath, () => {
          clearTimeout(followed.timer);
          followed.timer = setTimeout(() => void this.refresh(agentId), this.debounceMs);
        }),
        safety: setInterval(() => void this.refresh(agentId), this.safetyMs),
      };
      this.followed.set(agentId, followed);
    }
    return snapshot;
  }

  close(agentId: string): void {
    this.wanted.delete(agentId);
    const followed = this.followed.get(agentId);
    if (!followed) return;
    followed.stop();
    clearTimeout(followed.timer);
    clearInterval(followed.safety);
    this.followed.delete(agentId);
  }

  async fileDiff(agentId: string, path: string): Promise<FileDiff> {
    const { agent } = this.find(agentId);
    const snapshot = this.snapshots.get(agentId) ?? (await this.open(agentId));
    const file = snapshot.files.find((f) => f.path === path);
    if (!file) throw new IpcFailure('NOT_FOUND', `« ${path} » ne fait pas partie des changements.`);
    return this.git.fileDiff(agent.worktreePath, {
      base: snapshot.base,
      tree: snapshot.tree,
      path,
      oldPath: file.oldPath,
    });
  }

  /** Remembers or forgets the blob currently reviewed for `path` (FR-007, FR-009). */
  async setSeen(agentId: string, path: string, seen: boolean): Promise<void> {
    const { workspace } = this.find(agentId);
    const snapshot = this.snapshots.get(agentId) ?? (await this.open(agentId));
    const file = snapshot.files.find((f) => f.path === path);
    await this.workspaces.update(workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => {
        if (a.id !== agentId) return a;
        const next = Object.fromEntries(
          Object.entries(a.review.seen).filter(([seenPath]) => seenPath !== path),
        );
        if (seen && file) next[path] = seenBlob(file);
        return { ...a, review: { ...a.review, seen: next } };
      }),
    }));
    if (this.followed.has(agentId)) await this.refresh(agentId, true);
  }

  /**
   * The agents to review: done or awaiting a prompt, with at least one changed file
   * (FR-002, FR-003). Announced with `review:pending`.
   */
  async updatePending(workspaceId: string): Promise<string[]> {
    const run = (this.pendingRuns.get(workspaceId) ?? 0) + 1;
    this.pendingRuns.set(workspaceId, run);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return [];
    const agentIds: string[] = [];
    for (const agent of workspace.agents) {
      if (!READY.includes(agent.state)) continue;
      const snapshot = await this.compute(agent.id).catch(() => undefined);
      if (snapshot && !snapshot.missing && snapshot.files.length > 0) agentIds.push(agent.id);
    }
    if (this.pendingRuns.get(workspaceId) === run) this.onPending({ workspaceId, agentIds });
    return agentIds;
  }

  dispose(): void {
    for (const agentId of [...this.followed.keys()]) this.close(agentId);
    this.snapshots.clear();
    this.wanted.clear();
  }

  private async refresh(agentId: string, force = false) {
    if (!this.followed.has(agentId)) return;
    let snapshot: ReviewSnapshot;
    try {
      snapshot = await this.compute(agentId);
    } catch (error) {
      // A closed agent is no longer followed.
      if (error instanceof IpcFailure && error.code === 'NOT_FOUND') this.close(agentId);
      return;
    }
    // The review may have been closed while git ran.
    if (!this.followed.has(agentId)) return;
    const previous = this.snapshots.get(agentId);
    if (!force && previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return;
    this.snapshots.set(agentId, snapshot);
    this.onChanged(snapshot);
  }

  private async compute(agentId: string): Promise<ReviewSnapshot> {
    const { workspace, agent } = this.find(agentId);
    const cwd = agent.worktreePath;
    if (!(await isDirectory(cwd))) return missing(agent);
    // Only a worktree without a readable HEAD is gone; any other git error is reported, never
    // turned into « missing », which would leave nothing but « Abandonner » (FR-023).
    try {
      await this.git.revParse(cwd, 'HEAD');
    } catch {
      return missing(agent);
    }
    try {
      const [mainHead, base, { tree }, branch] = await Promise.all([
        this.git.revParse(cwd, workspace.mainBranch),
        this.git.mergeBase(cwd, workspace.mainBranch, 'HEAD'),
        this.git.snapshot(cwd),
        this.git.currentBranch(cwd),
      ]);
      const files = await this.git.changedFiles(cwd, base, tree);
      let added = 0;
      let removed = 0;
      for (const file of files) {
        added += file.added ?? 0;
        removed += file.removed ?? 0;
      }
      return {
        agentId,
        base,
        tree,
        branch: branch || agent.branch,
        files,
        added,
        removed,
        conflicts: 'none',
        mainHead,
        newSinceSeen: await this.newSinceSeen(cwd, agent, files),
        missing: false,
      };
    } catch (error) {
      throw new IpcFailure('GIT_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  /** Lines changed in files seen before, between the seen content and the current one. */
  private async newSinceSeen(cwd: string, agent: Agent, files: ReviewSnapshot['files']) {
    let added = 0;
    let removed = 0;
    let any = false;
    for (const file of files) {
      const seen = agent.review.seen[file.path];
      if (seen === undefined || seen === seenBlob(file)) continue;
      any = true;
      if (file.blob === null) continue;
      const counts = await this.git.diffBlobs(cwd, seen, file.blob);
      added += counts.added;
      removed += counts.removed;
    }
    return any ? { added, removed } : null;
  }

  private find(agentId: string) {
    for (const workspace of this.workspaces.list()) {
      const agent = workspace.agents.find((a) => a.id === agentId);
      if (agent) return { workspace, agent };
    }
    throw new IpcFailure('NOT_FOUND', 'Agent inconnu.');
  }
}

function missing(agent: Agent): ReviewSnapshot {
  return {
    agentId: agent.id,
    base: NO_COMMIT,
    tree: NO_COMMIT,
    branch: agent.branch,
    files: [],
    added: 0,
    removed: 0,
    conflicts: 'none',
    mainHead: NO_COMMIT,
    newSinceSeen: null,
    missing: true,
  };
}
