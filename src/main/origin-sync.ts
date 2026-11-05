// fix-todo-diff-notifications — every minute, and when a workspace opens, the main branch of origin
// is fetched (that branch only), then what is left to review is computed again.

export const ORIGIN_SYNC_MS = 60_000;

type Target = { id: string; path: string; mainBranch: string; available: boolean };

export class OriginSync {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      workspaces: () => readonly Target[];
      fetchOrigin: (cwd: string, branch: string) => Promise<boolean>;
      refresh: (workspaceId: string) => Promise<unknown>;
    },
  ) {}

  /** One workspace: a fetch that fails changes nothing, the last origin known stays the base. */
  async sync(workspaceId: string): Promise<void> {
    const target = this.deps.workspaces().find((ws) => ws.id === workspaceId);
    if (!target?.available || target.mainBranch === '') return;
    await this.deps.fetchOrigin(target.path, target.mainBranch);
    await this.deps.refresh(target.id).catch(() => undefined);
  }

  start(intervalMs = ORIGIN_SYNC_MS): void {
    this.stop();
    this.timer = setInterval(() => {
      for (const { id } of this.deps.workspaces()) void this.sync(id);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
