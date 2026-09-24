// T075 — follows the branch of each running agent: an agent may rename it (`git branch -m`), and
// the ⎇ tooltip shows the current name (FR-021, US3 scenario 3).

type Options = {
  currentBranch: (path: string) => Promise<string>;
  onBranch: (agentId: string, branch: string) => void;
  intervalMs?: number;
};

type Watched = { path: string; branch: string; timer: ReturnType<typeof setInterval> };

export class BranchWatcher {
  private readonly currentBranch: Options['currentBranch'];
  private readonly onBranch: Options['onBranch'];
  private readonly intervalMs: number;
  private readonly watched = new Map<string, Watched>();

  constructor({ currentBranch, onBranch, intervalMs = 5000 }: Options) {
    this.currentBranch = currentBranch;
    this.onBranch = onBranch;
    this.intervalMs = intervalMs;
  }

  /** Checks every `intervalMs` while the agent runs; `branch` is the name already known. */
  watch(agentId: string, path: string, branch: string): void {
    this.unwatch(agentId);
    const timer = setInterval(() => void this.check(agentId), this.intervalMs);
    timer.unref();
    this.watched.set(agentId, { path, branch, timer });
  }

  unwatch(agentId: string): void {
    const watched = this.watched.get(agentId);
    if (!watched) return;
    clearInterval(watched.timer);
    this.watched.delete(agentId);
  }

  /** Also called at the end of each turn (`Stop`), when a rename is most likely. */
  async check(agentId: string): Promise<void> {
    const watched = this.watched.get(agentId);
    if (!watched) return;
    let branch: string;
    try {
      branch = await this.currentBranch(watched.path);
    } catch {
      return; // worktree being removed, or git busy: the next check will tell
    }
    // Empty on a detached HEAD: the last known branch stays shown.
    if (!branch || branch === watched.branch || this.watched.get(agentId) !== watched) return;
    watched.branch = branch;
    this.onBranch(agentId, branch);
  }

  dispose(): void {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
  }
}
