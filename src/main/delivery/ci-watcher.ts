import {
  checkName,
  CI_POLL_MS,
  ciVerdict,
  FORGE_DOWN_MS,
  type CiCheck,
  type CiStatus,
  type Delivery,
} from '../../shared/delivery';
import type { Workspace } from '../../shared/model';
import type { GhClient } from './gh-client';

// 008 R9 — the CI of the followed PR, read by PACT alone (no agent): one timer per PR, `pr view` first
// (structure), then the checks of the head it names, never those of another commit (FR-009, FR-032).
// The watcher finds, the DeliveryService decides: Auto is read THERE, at the instant of the green
// (FR-011, SC-004).

export type CiForge = Pick<
  GhClient,
  'prView' | 'checkRuns' | 'statuses' | 'requiredChecks' | 'rerunJob'
>;

type Found = { workspaceId: string; deliveryId: string };

export interface CiWatcherDeps {
  /** The watcher writes `delivery.ci`, the last reading. */
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  forge: (workspaceId: string) => CiForge;
  /** `<owner>/<repo>` of the API paths. */
  repo: (workspaceId: string) => Promise<string>;
  /** R10 — whether `origin/<target>` holds a workflow. */
  workflows: (workspaceId: string, target: string) => Promise<boolean>;
  on: {
    /** Once per head, when the verdict turns green. */
    green(found: Found & { ci: CiStatus }): void | Promise<void>;
    red(found: Found & { ci: CiStatus; failing: string[] }): void | Promise<void>;
    /** The head of the PR is not a commit of PACT (FR-004). */
    dropped(found: Found & { head: string }): boolean | undefined | Promise<boolean | undefined>;
    alert(
      found: Found & { reason: 'stalled' | 'forge-down'; checks: string[] },
    ): void | Promise<void>;
    /** The PR is no longer open on the forge: merged or closed, by someone else or by us. */
    closed?(found: Found & { state: string }): boolean | undefined | Promise<boolean | undefined>;
  };
  /** The rhythm of the reads; `CI_POLL_MS` unless a test goes faster. */
  pollMs?: number;
}

/** The states of a request whose PR is read. */
export const READ_STATES: readonly string[] = ['watching', 'reviewing', 'merging', 'merge-failed'];
const STALLED = ['cancelled', 'timed_out', 'stale', 'action_required'];
/** A failed merge waits for the user: it is read this many times less often than a followed PR. */
const MERGE_FAILED_SLOWDOWN = 10;

type Entry = { timer: ReturnType<typeof setTimeout> | null; workspaceId: string };

export class CiWatcher {
  private readonly entries = new Map<string, Entry>();
  /** The head whose green was announced, per request: said once. */
  private readonly greenFor = new Map<string, string>();
  private readonly redFor = new Map<string, string>();
  private readonly alerted = new Map<string, Set<string>>();
  private readonly pollMs: number;
  private stopped = false;

  constructor(private readonly deps: CiWatcherDeps) {
    this.pollMs = deps.pollMs ?? CI_POLL_MS;
  }

  /** First read one period later, then every period. */
  track(workspaceId: string, deliveryId: string): void {
    this.start(workspaceId, deliveryId, this.pollMs);
  }

  /**
   * After a restart: each request in one of `states` is read at once. `watching` alone by default;
   * the service asks for every state that is read in session (`READ_STATES`).
   */
  resume(states: readonly string[] = ['watching']): void {
    for (const ws of this.deps.workspaces.list()) {
      for (const d of ws.deliveries) {
        if (d.pr !== null && states.includes(d.state)) this.start(ws.id, d.id, 0);
      }
    }
  }

  untrack(deliveryId: string): void {
    const entry = this.entries.get(deliveryId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(deliveryId);
    this.greenFor.delete(deliveryId);
    this.redFor.delete(deliveryId);
    this.alerted.delete(deliveryId);
  }

  dispose(): void {
    this.stopped = true;
    for (const id of [...this.entries.keys()]) this.untrack(id);
  }

  private start(workspaceId: string, deliveryId: string, delay: number): void {
    if (this.stopped || this.entries.has(deliveryId)) return;
    const entry: Entry = { timer: null, workspaceId };
    this.entries.set(deliveryId, entry);
    this.schedule(deliveryId, entry, delay);
  }

  private schedule(deliveryId: string, entry: Entry, delay: number): void {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.read(deliveryId, entry).finally(() => {
        // The read may have ended the follow: only a followed request goes on.
        if (this.entries.get(deliveryId) === entry && !this.stopped) {
          const failed = this.delivery(entry.workspaceId, deliveryId)?.state === 'merge-failed';
          this.schedule(
            deliveryId,
            entry,
            failed ? this.pollMs * MERGE_FAILED_SLOWDOWN : this.pollMs,
          );
        }
      });
    }, delay);
    entry.timer.unref();
  }

  private alive(deliveryId: string, entry: Entry): boolean {
    return this.entries.get(deliveryId) === entry;
  }

  private delivery(workspaceId: string, id: string): Delivery | undefined {
    return this.deps.workspaces.get(workspaceId)?.deliveries.find((d) => d.id === id);
  }

  private async read(id: string, entry: Entry): Promise<void> {
    const { workspaceId } = entry;
    try {
      const d = this.delivery(workspaceId, id);
      if (!d?.pr || !READ_STATES.includes(d.state)) {
        this.untrack(id);
        return;
      }
      await this.readOnce(d, id, entry);
    } catch {
      // A failed hook or write must not stop the follow: the next period reads again.
    }
  }

  private async readOnce(d: Delivery, id: string, entry: Entry): Promise<void> {
    const { workspaceId } = entry;
    const found = { workspaceId, deliveryId: id };
    const now = new Date().toISOString();
    const forge = this.deps.forge(workspaceId);
    const previous = d.ci;
    const number = (d.pr as NonNullable<Delivery['pr']>).number;

    let pr: Awaited<ReturnType<CiForge['prView']>>;
    try {
      pr = await forge.prView(number);
    } catch {
      await this.failed(d, entry, now, previous?.head ?? d.pushedHead ?? d.frozenCommit);
      return;
    }
    if (!this.alive(id, entry)) return;

    if (pr.state !== 'OPEN') {
      this.untrack(id);
      // A hook that did not take it (`false`) leaves the request followed: nothing is left unread.
      if ((await this.deps.on.closed?.({ ...found, state: pr.state })) === false) {
        this.start(workspaceId, id, this.pollMs);
      }
      return;
    }
    const head = pr.headRefOid;
    if (!d.pactCommits.includes(head)) {
      this.untrack(id);
      if ((await this.deps.on.dropped({ ...found, head })) === false) {
        this.start(workspaceId, id, this.pollMs);
      }
      return;
    }

    let checks: CiCheck[];
    let required: string[] | null;
    let configured: boolean | 'unknown';
    try {
      const repo = await this.deps.repo(workspaceId);
      const [runs, statuses, requirements, workflows] = await Promise.all([
        forge.checkRuns(repo, head),
        forge.statuses(repo, head),
        forge.requiredChecks(repo, d.target),
        this.deps.workflows(workspaceId, d.target),
      ]);
      required = requirements;
      configured =
        workflows || (required?.length ?? 0) > 0 ? true : required === null ? 'unknown' : false;
      checks = [
        // The id of a check run is the id of its job of GitHub Actions (what a rerun needs).
        ...runs.map((run) => ({
          id: run.id,
          name: checkName(run.name),
          status: run.status,
          conclusion: run.conclusion,
          job: run.id,
        })),
        ...statuses.map((status, index) => ({
          id: -(index + 1),
          name: checkName(status.context),
          status: status.state === 'pending' ? 'in_progress' : 'completed',
          conclusion:
            status.state === 'pending' ? null : status.state === 'success' ? 'success' : 'failure',
          job: null,
        })),
      ];
    } catch {
      await this.failed(d, entry, now, head);
      return;
    }
    if (!this.alive(id, entry)) return;

    const emptySince =
      checks.length > 0 ? null : previous?.head === head ? (previous.emptySince ?? now) : now;
    const verdict = ciVerdict({
      checks,
      required,
      configured,
      emptySince,
      now,
      readFailed: false,
    });

    const rerun = [...(previous?.rerun ?? [])];
    const rerunKeys = [...(previous?.rerunKeys ?? [])];
    const stalled = checks.filter(
      (c) => c.status === 'completed' && STALLED.includes(c.conclusion ?? ''),
    );
    let reran = false;
    if (verdict === 'stalled') {
      const repo = await this.deps.repo(workspaceId);
      for (const check of stalled) {
        // A rerun renews the id of the job: it is counted by the name of the check on this head.
        const key = `${head}:${check.name}`;
        if (check.job === null || rerunKeys.includes(key) || rerun.includes(check.job)) continue;
        try {
          await forge.rerunJob(repo, check.job);
          reran = true;
        } catch {
          // A rerun the forge refuses is not retried: the user is told next.
        }
        rerun.push(check.job);
        rerunKeys.push(key);
      }
    }

    const ci: CiStatus = {
      head,
      configured,
      checks,
      required,
      verdict,
      emptySince,
      failingSince: null,
      rerun,
      rerunKeys,
      readAt: now,
    };
    if (!this.alive(id, entry)) return;
    await this.save(workspaceId, id, previous, ci);

    if (verdict !== 'green') this.greenFor.delete(id);
    if (verdict !== 'red') this.redFor.delete(id);
    if (verdict !== 'stalled') this.alerted.get(id)?.delete('stalled');
    this.alerted.get(id)?.delete('forge-down');

    if (verdict === 'green' && this.greenFor.get(id) !== head) {
      this.greenFor.set(id, head);
      await this.deps.on.green({ ...found, ci });
    } else if (verdict === 'red' && this.redFor.get(id) !== head) {
      this.redFor.set(id, head);
      const failing = checks
        .filter((c) => c.status === 'completed' && c.conclusion === 'failure')
        .map((c) => c.name);
      await this.deps.on.red({ ...found, ci, failing });
    } else if (verdict === 'stalled' && !reran) {
      await this.alert(
        found,
        'stalled',
        stalled.map((c) => c.name),
      );
    }
  }

  /** A read that failed: unknown, never green; the alert comes after `FORGE_DOWN_MS` of failures. */
  private async failed(d: Delivery, entry: Entry, now: string, head: string): Promise<void> {
    const { workspaceId } = entry;
    const id = d.id;
    if (!this.alive(id, entry)) return;
    const previous = d.ci;
    const failingSince = previous?.failingSince ?? now;
    const ci: CiStatus = {
      head: previous?.head ?? head,
      configured: previous?.configured ?? 'unknown',
      checks: previous?.checks ?? [],
      required: previous?.required ?? null,
      verdict: 'unknown',
      emptySince: previous?.emptySince ?? null,
      failingSince,
      rerun: previous?.rerun ?? [],
      ...(previous?.rerunKeys === undefined ? {} : { rerunKeys: previous.rerunKeys }),
      readAt: now,
    };
    this.greenFor.delete(id);
    await this.save(workspaceId, id, previous, ci);
    if (Date.parse(now) - Date.parse(failingSince) >= FORGE_DOWN_MS) {
      await this.alert({ workspaceId, deliveryId: id }, 'forge-down', []);
    }
  }

  private async alert(found: Found, reason: 'stalled' | 'forge-down', checks: string[]) {
    const said = this.alerted.get(found.deliveryId) ?? new Set<string>();
    this.alerted.set(found.deliveryId, said);
    if (said.has(reason)) return;
    said.add(reason);
    await this.deps.on.alert({ ...found, reason, checks });
  }

  /** Written only when something other than the time of the reading changed. */
  private async save(workspaceId: string, id: string, previous: CiStatus | null, ci: CiStatus) {
    if (
      previous !== null &&
      JSON.stringify({ ...previous, readAt: '' }) === JSON.stringify({ ...ci, readAt: '' })
    ) {
      return;
    }
    await this.deps.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) => (d.id === id ? { ...d, ci } : d)),
    }));
  }
}
