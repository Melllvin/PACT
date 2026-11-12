import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_REASON,
  MAX_REBASES_IN_A_ROW,
  checkName,
  deliveryGate,
  isFinalState,
  prBody,
  type Delivery,
  type DeliveryState,
} from '../../shared/delivery';
import { IpcFailure } from '../../shared/ipc';
import type { ExchangeMessage } from '../../shared/exchanges';
import type { Agent, Loop, Workspace } from '../../shared/model';
import type { Integration } from '../../shared/review';
import type { GitService } from '../git/git-service';
import type { IntegrationService } from '../review/integration-service';
import { detectTestCommandIn } from '../review/test-runner';
import { WorktreeCleanup } from './cleanup';
import { isTestPath, type LoopService } from '../orchestrator/loop-service';
import type { RecordInput } from '../orchestrator/exchange-service';
import type { AgentManager } from '../agents/agent-manager';
import { CiWatcher, READ_STATES } from './ci-watcher';
import { GhFailure, type GhClient } from './gh-client';

// 008 R2 — the delivery of an accepted issue, from the barriers to the pull request: the state of the
// request is written before each effect (data-model), the steps run in a queue per project (like
// `IntegrationService.enqueue`), and every result wakes the orchestrator through the journal (R21).
// The CI is read by the `CiWatcher`; the merge happens when it turns green and Auto is on, or when the
// user validates (phase 5): always with `--match-head-commit`, never `--auto` (FR-009, FR-010, FR-031).

export type Forge = Pick<
  GhClient,
  | 'availability'
  | 'prCreate'
  | 'prView'
  | 'prMerge'
  | 'checkRuns'
  | 'statuses'
  | 'requiredChecks'
  | 'rerunJob'
  | 'jobLog'
>;

export interface DeliveryServiceDeps {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
    update(id: string, change: (ws: Workspace) => Workspace): Promise<Workspace>;
  };
  git: Pick<
    GitService,
    | 'revParse'
    | 'treeOf'
    | 'mergeBase'
    | 'changedFiles'
    | 'entry'
    | 'statusIgnored'
    | 'hasOrigin'
    | 'fetchRefs'
    | 'rebaseOnto'
    | 'pushBranch'
    | 'remoteBranchHead'
    | 'deleteRemoteBranch'
    | 'knownDefaultBranch'
    | 'addDetached'
    | 'removeDetached'
    | 'moveWorktree'
    | 'hasWorkflows'
    | 'commitsNotIn'
    | 'removeWorktreeDir'
    | 'deleteBranch'
  >;
  /** One client, or one per repository (`gh` runs in the repository of the project). */
  gh: Forge | ((repoPath: string) => Forge);
  loops: Pick<LoopService, 'reopen' | 'deliveryState' | 'get'>;
  integration: Pick<IntegrationService, 'start'>;
  /** The dev and the tester close at the merge; nothing is removed (FR-007, FR-039). */
  agents: Pick<AgentManager, 'close'>;
  /** The rhythm of the CI watcher; `CI_POLL_MS` by default. */
  pollMs?: number;
  /** The silence of a configured CI that is signalled; 10 min by default (a test goes faster). */
  silentMs?: number | undefined;
  exchanges: { record(workspaceId: string, draft: RecordInput): Promise<ExchangeMessage> };
  /** `<userData>/deliveries`: the place of the tests on the rebased commit, removed after. */
  deliveriesDir: string;
  /** The tests of PACT, run in `cwd`. */
  runTests(cwd: string, command: string): Promise<{ passed: boolean; tail: string }>;
  /** `workspace:deliveries`. */
  onChange?: (
    workspaceId: string,
    change: { deliveries: Delivery[]; delivery: Workspace['delivery'] },
  ) => void;
}

export type DeliveryRequest = {
  agentId: string;
  title: string;
  message: string;
  unverified?: boolean | undefined;
  requestedBy: Delivery['requestedBy'];
};

export type DeliveryDecision = {
  deliveryId: string;
  decision: 'validate' | 'refuse' | 'wait' | 'review';
  head: string;
  reason?: string | undefined;
};

/** The request fell while its steps ran (its agent was closed): they stop, nothing more is done. */
class Abandoned extends Error {}

type PushPlan = {
  ws: Workspace;
  gh: Forge;
  agent: Agent;
  rebased: string;
  login: string;
};

/** The run of a request ends here, with the state it ends in and what to tell. */
class Stop extends Error {
  constructor(
    readonly state: DeliveryState,
    readonly reason: string,
    readonly outcome:
      | 'refused'
      | 'dropped'
      | 'conflicted'
      | 'tests-failed'
      | 'ci-red'
      | 'closed'
      | 'user-refused'
      /** A PR that is no longer the expected one (FR-030): told as an alert, nothing created. */
      | 'foreign',
    /** What the orchestrator reads after the issue: the commit, the files. */
    readonly detail = '',
    /** `conflicted`, `tests-failed` and `ci-red` send the dev back for a counted round. */
    readonly reopen = false,
    /** 008 FR-026 — the user closed an agent: the loop closes, it does not go back to `running`. */
    readonly agentClosed = false,
  ) {
    super(reason);
  }
}

const short = (sha: string) => sha.slice(0, 7);
const MAX_ISSUE_TEXT = 20_000;
const MAX_TAIL = 500;

export class DeliveryService {
  /** One queue per project: the local steps of two requests never overlap. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** A decision in progress, by request: a second click finds it taken (FR-027). */
  private readonly deciding = new Set<string>();
  /** A merge in progress, by request: a second one never leaves, whoever asks (FR-027). */
  private readonly merging = new Set<string>();
  /** `<owner>/<repo>` of each project, read once from `gh repo view`. */
  private readonly repos = new Map<string, string>();
  private readonly watcher: CiWatcher;
  /** 008 US8, R17 — the worktrees of a merged request, removed when nothing is lost. */
  readonly worktreeCleanup: WorktreeCleanup;

  constructor(private readonly deps: DeliveryServiceDeps) {
    this.worktreeCleanup = new WorktreeCleanup({
      workspaces: deps.workspaces,
      git: deps.git,
      mergedHead: async (ws, d) => {
        // The forge says which head was merged; PACT's own record is the fallback of an unreachable forge.
        if (d.pr !== null) {
          const view = await this.forge(ws)
            .prView(d.pr.number)
            .catch(() => null);
          if (view !== null && view.headRefOid !== '') return view.headRefOid;
        }
        return d.pushedHead;
      },
      save: (workspaceId, deliveryId, change) => this.save(workspaceId, deliveryId, change),
    });
    this.watcher = new CiWatcher({
      workspaces: {
        get: (id) => deps.workspaces.get(id),
        list: () => deps.workspaces.list(),
        update: async (id, change) => {
          const ws = await deps.workspaces.update(id, change);
          deps.onChange?.(id, { deliveries: ws.deliveries, delivery: ws.delivery });
          return ws;
        },
      },
      forge: (workspaceId) => this.forge(this.workspace(workspaceId)),
      repo: (workspaceId) => this.repoOf(workspaceId),
      workflows: (workspaceId, target) =>
        deps.git.hasWorkflows(this.workspace(workspaceId).path, `origin/${target}`),
      on: {
        green: ({ workspaceId, deliveryId }) => this.onGreen(workspaceId, deliveryId),
        red: ({ workspaceId, deliveryId, failing }) => this.onRed(workspaceId, deliveryId, failing),
        dropped: ({ workspaceId, deliveryId, head }) =>
          this.onDropped(workspaceId, deliveryId, head),
        alert: ({ workspaceId, deliveryId, reason, checks }) =>
          this.onAlert(workspaceId, deliveryId, reason, checks),
        closed: ({ workspaceId, deliveryId, state }) =>
          this.onClosedOnForge(workspaceId, deliveryId, state),
        behind: ({ workspaceId, deliveryId, head }) => this.onBehind(workspaceId, deliveryId, head),
      },
      ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
      silentMs: deps.silentMs,
    });
  }

  /**
   * Every request that was under way when the app stopped goes on (US6 sc.1, SC-005): the follow of the
   * PR that were `watching`, the merges that were under way, and the steps that came before the PR.
   * Nothing is made twice: a PR noted is read by its number, a merge is asked of the forge first.
   */
  async resume(): Promise<void> {
    for (const ws of this.deps.workspaces.list()) {
      for (const d of ws.deliveries) {
        // US8 — PACT stopped between the merge and the cleanup: it is replayed, the conditions read again.
        if (d.channel === 'github' && d.state === 'merged' && d.cleanup === 'pending') {
          await this.worktreeCleanup.run(ws.id, d.id);
          continue;
        }
        if (d.channel !== 'github' || isFinalState(d.state)) continue;
        // R2 — the state was written before the effect. Before the PR exists, the steps start again:
        // each one is safe to repeat (the push is a lease on PACT's own head, `gh pr create` itself
        // refuses a second PR for the branch), and a PR already noted is never created again.
        if (d.pr === null) {
          if (['syncing', 'testing', 'pushing', 'opening'].includes(d.state)) {
            await this.restart(ws.id, d.id);
          }
          continue;
        }
        if (d.state !== 'merging' && d.state !== 'opening') continue;
        // `merging` was written before the call: the forge says whether it went through.
        // `opening` with its PR noted: the PR exists, it is followed by its number.
        try {
          const pr = await this.forge(ws).prView(d.pr.number);
          if (pr.state === 'MERGED') await this.merged(ws.id, d.id);
          else if (pr.state === 'OPEN') await this.save(ws.id, d.id, { state: 'watching' });
          else await this.onClosedOnForge(ws.id, d.id, pr.state);
        } catch {
          await this.save(ws.id, d.id, { state: 'watching' });
        }
      }
    }
    this.watcher.resume(READ_STATES);
  }

  /** The steps of a request that stopped before its PR was noted, taken up again in the queue. */
  private async restart(workspaceId: string, id: string): Promise<void> {
    const forge = await this.forge(this.workspace(workspaceId)).availability();
    if (!forge.ok) {
      await this.end(
        workspaceId,
        id,
        new Stop('refused', `${forge.reason} ${forge.remedy}`, 'refused'),
      );
      return;
    }
    this.background(workspaceId, id, forge.login);
  }

  /** `run` in the queue of the project, behind the caller: it ends its request itself. */
  private background(workspaceId: string, id: string, login: string): void {
    // A failure of that very write is all that can reach here.
    this.enqueue(workspaceId, () => this.run(workspaceId, id, login)).catch(() => undefined);
  }

  private async repoOf(workspaceId: string): Promise<string> {
    const known = this.repos.get(workspaceId);
    if (known !== undefined) return known;
    const forge = await this.forge(this.workspace(workspaceId)).availability();
    if (!forge.ok) throw new GhFailure(forge.reason);
    this.repos.set(workspaceId, forge.repo.nameWithOwner);
    return forge.repo.nameWithOwner;
  }

  private forge(ws: Workspace): Forge {
    const { gh } = this.deps;
    return typeof gh === 'function' ? gh(ws.path) : gh;
  }

  private workspace(id: string): Workspace {
    const ws = this.deps.workspaces.get(id);
    if (!ws) throw new IpcFailure('NOT_FOUND', 'Workspace introuvable.');
    return ws;
  }

  private current(workspaceId: string, id: string): Delivery {
    const found = this.workspace(workspaceId).deliveries.find((d) => d.id === id);
    if (!found) throw new IpcFailure('NOT_FOUND', 'Livraison introuvable.');
    return found;
  }

  /** The request as it is now, written before the next effect. */
  private async save(
    workspaceId: string,
    id: string,
    change: Partial<Delivery>,
  ): Promise<Delivery> {
    const ws = await this.deps.workspaces.update(workspaceId, (current) => ({
      ...current,
      deliveries: current.deliveries.map((d) =>
        d.id === id ? { ...d, ...change, updatedAt: new Date().toISOString() } : d,
      ),
    }));
    this.deps.onChange?.(workspaceId, { deliveries: ws.deliveries, delivery: ws.delivery });
    return this.current(workspaceId, id);
  }

  private enqueue<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(workspaceId) ?? Promise.resolve()).then(task);
    this.queues.set(
      workspaceId,
      result.catch(() => undefined),
    );
    return result;
  }

  /** « Livrer » / `request_delivery`: the barriers, then the steps in the background (FR-002). */
  async request(workspaceId: string, input: DeliveryRequest): Promise<Delivery> {
    const ws = this.workspace(workspaceId);
    const agent = ws.agents.find((a) => a.id === input.agentId);
    if (!agent) throw new IpcFailure('NOT_FOUND', 'Agent introuvable.');
    const unverified = input.unverified === true;
    const loop = unverified ? null : this.loopOf(ws, agent.id);
    const head = await this.deps.git.revParse(agent.worktreePath, 'HEAD');
    const now = new Date().toISOString();
    // FR-014 — after a refusal the next request is shown to the user once more, Auto or not.
    const previous = ws.deliveries.filter((x) => x.branch === agent.branch).at(-1);
    const delivery: Delivery = {
      id: randomUUID(),
      agentId: agent.id,
      testAgentId: loop?.testAgentId ?? null,
      issueId: loop?.issueId ?? null,
      branch: agent.branch,
      target: agent.baseBranch || ws.mainBranch,
      channel: (await this.deps.git.hasOrigin(ws.path)) ? 'github' : 'local',
      unverified,
      title: input.title,
      message: input.message,
      frozenCommit: head,
      verdictCommit: null,
      pactCommits: [head],
      pushedHead: null,
      rebases: 0,
      state: 'checking',
      reason: null,
      pr: null,
      ci: null,
      review: { required: unverified || previous?.review.refusedOnce === true, refusedOnce: false },
      cleanup: 'none',
      requestedBy: input.requestedBy,
      at: now,
      updatedAt: now,
    };
    await this.deps.workspaces.update(workspaceId, (current) => ({
      ...current,
      deliveries: [...current.deliveries, delivery],
    }));
    this.changed(workspaceId);

    const refusal = await this.barriers(ws, agent, loop, delivery);
    if (refusal !== null) return this.end(workspaceId, delivery.id, refusal);

    let login = '';
    if (delivery.channel === 'github') {
      const forge = await this.forge(ws).availability();
      if (!forge.ok) {
        return this.end(
          workspaceId,
          delivery.id,
          new Stop('refused', `${forge.reason} ${forge.remedy}`, 'refused'),
        );
      }
      login = forge.login;
    }

    if (loop) await this.deps.loops.deliveryState(workspaceId, loop.issueId, 'delivering');
    if (delivery.channel === 'local')
      return this.save(workspaceId, delivery.id, { state: 'reviewing' });
    this.background(workspaceId, delivery.id, login);
    return this.current(workspaceId, delivery.id);
  }

  /**
   * The lease of a first push: the remote head when PACT pushed it itself (a request that stopped
   * after its push, a PR that failed to open for instance), else an absent branch. Anyone else's
   * head, or a branch PACT pushed and someone deleted, is not taken for PACT's.
   */
  private async lease(ws: Workspace, d: Delivery, rebased: string): Promise<string | null> {
    const remote = await this.deps.git.remoteBranchHead(ws.path, d.branch);
    // The commit to push is already there (a push that went through before the crash): pushing it
    // again changes nothing, whoever wrote it.
    const ours =
      remote === rebased ||
      this.workspace(ws.id).deliveries.some(
        (x) =>
          x.branch === d.branch &&
          (x.pushedHead === remote || x.pactCommits.includes(remote ?? '')),
      );
    return remote !== null && ours ? remote : null;
  }

  private changed(workspaceId: string) {
    const ws = this.workspace(workspaceId);
    this.deps.onChange?.(workspaceId, { deliveries: ws.deliveries, delivery: ws.delivery });
  }

  /** The loop a dev is in: the accepted or polishing one first, else the last. */
  private loopOf(ws: Workspace, devId: string): Loop | null {
    const loops = ws.loops.filter((l) => l.devAgentId === devId);
    return (
      loops.find((l) => l.state === 'accepted' || l.state === 'polishing') ?? loops.at(-1) ?? null
    );
  }

  /** The files of the dev's worktree that are not committed (untracked ones included). */
  private async uncommitted(agent: Agent): Promise<string[]> {
    const status = await this.deps.git.statusIgnored(agent.worktreePath);
    return [...status.modified, ...status.untracked];
  }

  /** `contracts/mcp-tools.md` — the refusal of the barriers, or `null`. */
  private async barriers(
    ws: Workspace,
    agent: Agent,
    loop: Loop | null,
    delivery: Delivery,
  ): Promise<Stop | null> {
    const head = delivery.frozenCommit;
    // Read again, now that this request is written: of two requests at once, the first one written
    // runs and the later one is refused (T012, one request that is not final per dev).
    const written = this.workspace(ws.id).deliveries;
    const inFlight =
      written
        .slice(
          0,
          written.findIndex((d) => d.id === delivery.id),
        )
        .find((d) => d.agentId === agent.id && !isFinalState(d.state))?.state ?? null;
    // Another request first: the other barriers are about a loop it already holds.
    if (inFlight !== null) {
      return new Stop('refused', `Une livraison est déjà en cours (${inFlight}).`, 'refused');
    }
    const last = loop?.rounds.at(-1);
    const verdict = last?.reports.filter((r) => r.role === 'test').at(-1);
    const missingTests = delivery.unverified ? [] : await this.missingTests(ws, agent, loop, head);
    const gate = deliveryGate({
      issue: loop?.issueId ?? null,
      loopState: loop?.state ?? null,
      head,
      verdictCommit: verdict?.verdict?.result === 'accepted' ? (verdict.commit ?? null) : null,
      proofCommit: last?.proof?.commit ?? null,
      uncommitted: await this.uncommitted(agent),
      missingTests,
      polish: loop?.polish ?? null,
      inFlight: null,
      unverified: delivery.unverified,
    });
    if (gate.ok) {
      return null;
    }
    if (missingTests.length > 0 && loop) {
      // `missingTests` only lists files when the tester exists.
      const tester = ws.agents.find((a) => a.id === loop.testAgentId) as Agent;
      await this.deps.exchanges.record(ws.id, {
        from: 'pact',
        to: agent.id,
        kind: 'instruction',
        text: `Récupère les tests du testeur avant la livraison : git checkout ${tester.branch} -- ${missingTests.join(' ')}, puis commite-les et redemande la livraison.`,
        unreadBy: [agent.id],
      });
    }
    return new Stop('refused', gate.reason, 'refused');
  }

  /**
   * research R4 — the test files the tester changed since its real bases that the dev's head does not
   * hold identically (same blob, or absent from both).
   */
  private async missingTests(
    ws: Workspace,
    dev: Agent,
    loop: Loop | null,
    head: string,
  ): Promise<string[]> {
    const tester = ws.agents.find((a) => a.id === loop?.testAgentId);
    if (!tester) return [];
    const { git } = this.deps;
    const testerHead = await git.revParse(tester.worktreePath, 'HEAD');
    const tree = await git.treeOf(tester.worktreePath, 'HEAD');
    const bases = [
      ws.mainBranch,
      `origin/${ws.mainBranch}`,
      ...(tester.baseBranch === ws.mainBranch ? [] : [tester.baseBranch]),
    ];
    let files: string[] | null = null;
    for (const base of bases) {
      const from = await git.mergeBase(tester.worktreePath, 'HEAD', base).catch(() => null);
      if (from === null) continue;
      const changed = (await git.changedFiles(tester.worktreePath, from, tree))
        .map((f) => f.path)
        .filter((p) => isTestPath(p, ws.testPaths));
      files = files === null ? changed : files.filter((p) => changed.includes(p));
    }
    const missing: string[] = [];
    for (const path of files ?? []) {
      const [theirs, mine] = await Promise.all([
        git.entry(tester.worktreePath, testerHead, path),
        git.entry(dev.worktreePath, head, path),
      ]);
      if (theirs?.oid !== mine?.oid || theirs?.mode !== mine?.mode) missing.push(path);
    }
    return missing;
  }

  /** The steps of a request on the forge, one project at a time (R5, R7). */
  private async run(workspaceId: string, id: string, login: string): Promise<void> {
    try {
      await this.steps(workspaceId, id, login);
    } catch (error) {
      if (error instanceof Abandoned) return;
      const stop =
        error instanceof Stop
          ? error
          : new Stop(
              'refused',
              error instanceof Error ? error.message.slice(0, MAX_TAIL) : 'Échec inattendu.',
              'refused',
            );
      await this.end(workspaceId, id, stop);
    }
  }

  private async steps(workspaceId: string, id: string, login: string): Promise<void> {
    const ws = this.workspace(workspaceId);
    const gh = this.forge(ws);
    // US6 sc.1, SC-005 — a request that stopped in `pushing` or `opening` goes on from the commit it
    // recorded (`pactCommits`, written before the tests): a new rebase would give another commit,
    // and the branch PACT may have pushed already would no longer be recognised as its own.
    const recorded = this.current(workspaceId, id);
    const again =
      (recorded.state === 'pushing' || recorded.state === 'opening') && recorded.pr === null;
    const d = again ? recorded : await this.save(workspaceId, id, { state: 'syncing' });
    const agent = ws.agents.find((a) => a.id === d.agentId) as Agent;
    await this.ensureHead(agent, d);
    const rebased = again ? (d.pactCommits.at(-1) as string) : await this.rebased(ws, d);
    await this.pushAndOpen(workspaceId, this.current(workspaceId, id), {
      ws,
      gh,
      agent,
      rebased,
      login,
    });
  }

  /** R5 — the request brought up to date on the target, and its tests run on the result. */
  private async rebased(ws: Workspace, start: Delivery): Promise<string> {
    const { git } = this.deps;
    const workspaceId = ws.id;
    const id = start.id;
    let d = start;
    if (!(await git.fetchRefs(ws.path, [d.target]))) {
      throw new Stop('refused', 'Le dépôt distant est injoignable (fetch).', 'refused');
    }
    const onto = `origin/${d.target}`;
    const rebase = await git
      .rebaseOnto(ws.path, {
        commit: d.frozenCommit,
        onto,
        dir: join(this.deps.deliveriesDir, d.id),
      })
      .catch((error: unknown) => {
        const why = error instanceof Error ? error.message.slice(0, MAX_TAIL) : 'erreur de git';
        throw new Stop(
          'conflicted',
          `Recalage impossible sur ${onto} : ${why}. ${this.redo(onto)}`,
          'conflicted',
          'recalage impossible',
          true,
        );
      });
    if (rebase.commit === null) {
      const files = rebase.conflicts.join(', ');
      throw new Stop(
        'conflicted',
        `Conflit au recalage sur ${onto} : ${files}. ${this.redo(onto)}`,
        'conflicted',
        files,
        true,
      );
    }
    const rebased = rebase.commit;
    d = await this.save(workspaceId, id, {
      state: 'testing',
      pactCommits: [...new Set([...d.pactCommits, rebased])],
      verdictCommit: d.unverified ? null : rebased,
    });

    const red = await this.testsOn(ws, d, rebased);
    if (red) throw red;
    return rebased;
  }

  /** The push of the recorded commit, then the PR: opened, resumed from an earlier request, or adopted. */
  private async pushAndOpen(
    workspaceId: string,
    start: Delivery,
    { ws, gh, agent, rebased, login }: PushPlan,
  ): Promise<void> {
    const { git } = this.deps;
    const id = start.id;
    let d = start;
    await this.ensureHead(agent, d);

    // R22 — the PR of a request that fell is read by its number before anything is pushed.
    const resumed = await this.resumablePr(workspaceId, d, gh);

    d = await this.save(workspaceId, id, { state: 'pushing' });
    if (
      !(await git.pushBranch(ws.path, {
        commit: rebased,
        branch: d.branch,
        expected: d.pushedHead ?? (await this.lease(ws, d, rebased)),
      }))
    ) {
      throw new Stop(
        'refused',
        `Le push de ${d.branch} est refusé : la branche distante a bougé.`,
        'refused',
      );
    }
    d = await this.save(workspaceId, id, { state: 'opening', pushedHead: rebased });

    const issue = ws.issues.find((i) => i.id === d.issueId);
    const tester = d.testAgentId;
    let pr: { number: number; url: string };
    let adopted = false;
    if (resumed) {
      // R22 — after the push, the head of the PR must be the commit PACT pushed.
      const view = await gh.prView(resumed.number);
      if (view.state !== 'OPEN' || view.headRefOid !== rebased) {
        throw new Stop(
          'refused',
          `La PR #${String(resumed.number)} n’a pas la tête poussée par PACT (${short(rebased)}) : reprise arrêtée, rien n’est créé ni suivi.`,
          'foreign',
        );
      }
      pr = { number: resumed.number, url: resumed.url };
    } else {
      try {
        pr = await gh.prCreate({
          head: d.branch,
          base: d.target,
          title: d.title,
          body: prBody({
            issue: issue
              ? {
                  id: issue.id,
                  remote: issue.remote,
                  text: await this.issueText(agent, issue.path),
                }
              : null,
            message: d.message,
            verdict:
              tester === null || d.unverified
                ? null
                : { result: 'accepted', commit: rebased, tester },
          }),
        });
      } catch (error) {
        const reason = error instanceof GhFailure ? error.reason : 'gh a échoué.';
        // A crash between `gh pr create` and the note of its number: gh says which PR exists. The
        // number is read from that answer (never searched, FR-030) and the PR is checked (FR-031).
        const existing = /already exists:\s*\S*\/pull\/(\d+)\s*$/.exec(reason)?.[1];
        if (existing === undefined) throw new Stop('refused', reason, 'refused');
        pr = await this.adopt(workspaceId, gh, d, { number: Number(existing), rebased, login });
        adopted = true;
      }
    }
    d = await this.save(workspaceId, id, {
      pr: { number: pr.number, url: pr.url, expectedAuthor: resumed?.expectedAuthor ?? login },
    });
    await this.tell(
      workspaceId,
      d,
      'pr-opened',
      `PR #${String(pr.number)} ${resumed || adopted ? 'reprise' : 'ouverte'} · ${this.label(d)} · ${short(rebased)}`,
      {
        pr: { number: pr.number, url: pr.url },
        commit: rebased,
      },
    );
    await this.catchUp(workspaceId, agent, d, rebased);
    await this.save(workspaceId, id, { state: 'watching' });
    this.watcher.track(workspaceId, id);
  }

  /**
   * FR-031 — the PR that gh reports as existing for the branch is followed only if it is PACT's: our
   * account as author, not from a fork, the commit PACT pushed as head, the target as base. Anything
   * else ends the request in French; no text of the PR (title, body) is read nor carried.
   */
  private async adopt(
    workspaceId: string,
    gh: Forge,
    d: Delivery,
    { number, rebased, login }: { number: number; rebased: string; login: string },
  ): Promise<{ number: number; url: string }> {
    const refuse = (why: string) =>
      new Stop(
        'refused',
        `La PR #${String(number)} existe déjà pour ${d.branch} mais ${why} : PACT ne la suit pas et n’en crée pas d’autre. Vérifie-la sur GitHub, ferme-la si elle n’est pas la tienne, puis relance la livraison.`,
        'foreign',
      );
    let view;
    try {
      view = await gh.prView(number);
    } catch {
      throw refuse('elle n’a pas pu être lue');
    }
    if (view.state !== 'OPEN') throw refuse('elle n’est plus ouverte');
    if (view.author.login !== login) throw refuse('son auteur n’est pas ton compte');
    if (view.isCrossRepository) throw refuse('elle vient d’un autre dépôt');
    if (view.headRefOid !== rebased) throw refuse('sa tête n’est pas le commit poussé par PACT');
    if (view.baseRefName !== d.target) throw refuse(`sa base n’est pas ${d.target}`);
    const repo = await this.repoOf(workspaceId);
    return { number, url: `https://github.com/${repo}/pull/${String(number)}` };
  }

  /**
   * R22 — the PR of the last request of this branch that fell, if it is still open, by the same
   * author and not from a fork: it is resumed. Closed, merged or gone: a new PR. Any other open PR
   * is neither resumed nor replaced (FR-030). Read by its number: never listed, never searched.
   */
  private async resumablePr(
    workspaceId: string,
    d: Delivery,
    gh: Forge,
  ): Promise<NonNullable<Delivery['pr']> | null> {
    const all = this.workspace(workspaceId).deliveries;
    const earlier = all
      .slice(
        0,
        all.findIndex((x) => x.id === d.id),
      )
      .filter((x) => x.branch === d.branch && x.pr !== null && isFinalState(x.state))
      .at(-1)?.pr;
    if (!earlier) return null;
    let view;
    try {
      view = await gh.prView(earlier.number);
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      const stderr = (error as { stderr?: unknown }).stderr;
      if (
        /Could not resolve to a pull request|no pull requests? found/i.test(
          `${text}\n${typeof stderr === 'string' ? stderr : ''}`,
        )
      ) {
        return null;
      }
      throw new Stop('refused', `La PR #${String(earlier.number)} n’a pas pu être lue.`, 'refused');
    }
    if (view.state !== 'OPEN') return null;
    if (view.author.login !== earlier.expectedAuthor || view.isCrossRepository) {
      throw new Stop(
        'refused',
        `La PR #${String(earlier.number)} n’a plus l’auteur attendu ou vient d’un autre dépôt : ni reprise ni nouvelle PR.`,
        'foreign',
      );
    }
    return earlier;
  }

  private redo(onto: string): string {
    return `Recale ta branche sur ${onto} (git rebase ${onto}), résous les conflits, commite, puis redemande un verdict.`;
  }

  /** The tests of PACT on the rebased commit, in a place of PACT's own: `null` when they pass (or are none). */
  private async testsOn(ws: Workspace, d: Delivery, rebased: string): Promise<Stop | null> {
    const { git } = this.deps;
    const dir = join(this.deps.deliveriesDir, d.id);
    await git.addDetached(ws.path, dir, rebased);
    try {
      const command = ws.testCommand ?? (await detectTestCommandIn(dir));
      if (command === null) return null;
      const run = await this.deps.runTests(dir, command);
      return run.passed
        ? null
        : new Stop(
            'tests-failed',
            `Tests rouges sur ${short(rebased)}${run.tail ? ` : ${run.tail.slice(-MAX_TAIL)}` : ''}`,
            'tests-failed',
            short(rebased),
            true,
          );
    } finally {
      await git.removeDetached(ws.path, dir);
    }
  }

  /** The head of the dev is still F: a commit PACT did not make drops the request (R6). */
  private async ensureHead(agent: Agent, d: Delivery): Promise<void> {
    // A request that fell meanwhile (agent closed) does not push nor open anything more.
    const now = this.deps.workspaces.get(agent.workspaceId);
    if (now?.deliveries.some((x) => x.id === d.id && isFinalState(x.state))) throw new Abandoned();
    const head = await this.deps.git.revParse(agent.worktreePath, 'HEAD');
    if (head !== d.frozenCommit) {
      throw new Stop(
        'dropped',
        `Le commit ${short(head)} de ${d.branch} n’est pas de PACT.`,
        'dropped',
        `commit ${short(head)} étranger à PACT`,
      );
    }
  }

  private async issueText(agent: Agent, path: string): Promise<string> {
    try {
      return (await readFile(join(agent.worktreePath, path), 'utf8')).slice(0, MAX_ISSUE_TEXT);
    } catch {
      return '';
    }
  }

  /** R5 — the worktree of the dev brought to R, only if it is idle, clean and still on F. */
  private async catchUp(workspaceId: string, agent: Agent, d: Delivery, rebased: string) {
    if (rebased === d.frozenCommit) return;
    const now = this.workspace(workspaceId).agents.find((a) => a.id === agent.id);
    if (!now || now.state === 'working') return;
    const { git } = this.deps;
    try {
      if ((await git.revParse(now.worktreePath, 'HEAD')) !== d.frozenCommit) return;
      if ((await this.uncommitted(now)).length > 0) return;
      await git.moveWorktree(
        now.worktreePath,
        rebased,
        await git.treeOf(now.worktreePath, rebased),
      );
    } catch {
      // The worktree stays where it was: FR-037 decides at the merge.
    }
  }

  private label(d: Delivery): string {
    return d.issueId ?? d.branch;
  }

  /** A request ends: its final state, the loop where it goes next, the word to the orchestrator. */
  private async end(workspaceId: string, id: string, stop: Stop): Promise<Delivery> {
    this.watcher.untrack(id);
    // The loop and the word to the orchestrator come first: a final state is read as « all done ».
    let d = this.current(workspaceId, id);
    const issue = d.issueId;
    const loop = issue === null ? null : this.deps.loops.get(workspaceId, issue);
    let text: string;
    const outcome: NonNullable<ExchangeMessage['delivery']>['outcome'] =
      stop.outcome === 'closed' || stop.outcome === 'foreign' ? 'alert' : stop.outcome;
    if (stop.outcome === 'refused' || stop.outcome === 'closed' || stop.outcome === 'foreign') {
      text =
        stop.outcome === 'closed'
          ? `Livraison · PR #${String(this.prOf(d).number)} · ${stop.reason}`
          : stop.outcome === 'foreign'
            ? `Livraison · ${this.label(d)} · ${stop.reason}`
            : `Livraison refusée · ${this.label(d)} · ${stop.reason}`;
      // The verdict and the proof still stand: the loop is as it was.
      if (loop?.state === 'delivering') {
        await this.deps.loops.deliveryState(workspaceId, loop.issueId, 'accepted');
      }
    } else if (stop.outcome === 'dropped') {
      text = `Livraison tombée · ${this.label(d)} · ${stop.detail}`;
      // A foreign commit: the verdict no longer holds, the same round runs again. An agent closed:
      // the loop is over and its issue free (FR-026).
      if (loop) {
        await this.deps.loops.deliveryState(
          workspaceId,
          loop.issueId,
          stop.agentClosed ? 'closed' : 'running',
        );
      }
    } else {
      const reopened =
        loop && stop.reopen
          ? await this.deps.loops.reopen(workspaceId, loop.issueId, stop.reason)
          : null;
      const what =
        stop.outcome === 'conflicted'
          ? `Conflit au recalage · ${this.label(d)} · ${stop.detail}`
          : stop.outcome === 'ci-red'
            ? `CI rouge · PR #${String(this.prOf(d).number)} · ${stop.detail}`
            : stop.outcome === 'user-refused'
              ? `PR #${String(this.prOf(d).number)} refusée par l’utilisateur · ${this.label(d)} · ${stop.detail}`
              : `Tests rouges sur ${stop.detail} · ${this.label(d)}`;
      text =
        reopened === null
          ? what
          : reopened.state === 'escalated'
            ? `${what} : plafond atteint, l’utilisateur décide`
            : `${what} : tour ${String(reopened.round)} ouvert`;
    }
    await this.tell(workspaceId, d, outcome, text);
    d = await this.save(workspaceId, id, { state: stop.state, reason: stop.reason });
    return d;
  }

  /** The orchestrator hears of a result (R21); a project without one has nobody to tell. */
  private async tell(
    workspaceId: string,
    d: Delivery,
    outcome: NonNullable<ExchangeMessage['delivery']>['outcome'],
    text: string,
    extra: { pr?: { number: number; url: string }; commit?: string; checks?: string[] } = {},
  ): Promise<void> {
    const ws = this.workspace(workspaceId);
    const lead = ws.agents.find((a) => a.role === 'orchestrator');
    if (!lead) return;
    await this.deps.exchanges.record(workspaceId, {
      from: 'pact',
      to: lead.id,
      about: d.agentId,
      kind: 'delivery',
      text,
      delivery: { id: d.id, outcome, ...extra },
      unreadBy: [lead.id],
    });
  }

  /**
   * « Fusionner » / « Refuser » of the local channel (FR-008, FR-027): one decision at a time per
   * request, the head shown must be the frozen one.
   */
  async decide(input: DeliveryDecision): Promise<Delivery> {
    const owner = this.deps.workspaces
      .list()
      .find((w) => w.deliveries.some((d) => d.id === input.deliveryId));
    if (!owner) throw new IpcFailure('NOT_FOUND', 'Livraison introuvable.');
    const workspaceId = owner.id;
    const found = this.current(workspaceId, input.deliveryId);
    if (found.channel === 'github') return this.decideOnForge(workspaceId, found, input);
    if (input.decision === 'wait' || input.decision === 'review') {
      throw new IpcFailure('INVALID_INPUT', 'Cette décision ne concerne qu’une PR.');
    }
    if (found.state !== 'reviewing') {
      throw new IpcFailure('INVALID_INPUT', 'Cette livraison n’attend pas de décision.');
    }
    if (this.deciding.has(found.id)) return found;
    this.deciding.add(found.id);
    try {
      if (input.head !== found.frozenCommit) {
        throw new IpcFailure('INVALID_INPUT', 'La tête a changé depuis l’affichage : recharge.');
      }
      const ws = this.workspace(workspaceId);
      const agent = ws.agents.find((a) => a.id === found.agentId);
      if (!agent) throw new IpcFailure('NOT_FOUND', 'Agent introuvable.');
      if (input.decision === 'refuse')
        return await this.refuseLocal(workspaceId, found, input.reason);
      const head = await this.deps.git.revParse(agent.worktreePath, 'HEAD');
      if (head !== found.frozenCommit) {
        return await this.end(
          workspaceId,
          found.id,
          new Stop(
            'dropped',
            `Le commit ${short(head)} de ${found.branch} n’est pas de PACT.`,
            'dropped',
            `commit ${short(head)} étranger à PACT`,
          ),
        );
      }
      const files = await this.uncommitted(agent);
      if (files.length > 0) {
        throw new IpcFailure(
          'INVALID_INPUT',
          `Changements non commités : ${files.slice(0, 10).join(', ')}.`,
        );
      }
      await this.save(workspaceId, found.id, { state: 'merging' });
      try {
        await this.deps.integration.start({
          agentId: agent.id,
          mode: ws.delivery.mergeMode === 'squash' ? 'squash' : 'keep-commits',
          message: found.message,
          after: { closeTile: true, removeWorktree: false },
          requestId: found.id,
        });
      } catch (error) {
        await this.save(workspaceId, found.id, { state: 'reviewing' });
        throw error;
      }
      return this.current(workspaceId, found.id);
    } finally {
      this.deciding.delete(found.id);
    }
  }

  /**
   * « Valider » / « Refuser » of a PR (FR-013, FR-014, FR-027): one decision at a time per request,
   * on the head the user was shown; a second click finds the first one under way and changes nothing.
   */
  private async decideOnForge(
    workspaceId: string,
    found: Delivery,
    input: DeliveryDecision,
  ): Promise<Delivery> {
    // A merge under way (Auto's, the other click's) is not raced: Valider finds it taken, Refuser is
    // refused while it runs.
    const underWay = this.merging.has(found.id) || found.state === 'merging';
    if (underWay && input.decision === 'refuse') {
      throw new IpcFailure('INVALID_INPUT', 'Une fusion est en cours : le refus vient trop tard.');
    }
    if (underWay || this.deciding.has(found.id)) return found;
    // The item may be shown while the PR is watched (a review that is owed); the CI decides below.
    if (found.state !== 'reviewing' && found.state !== 'watching') {
      throw new IpcFailure('INVALID_INPUT', 'Cette livraison n’attend pas de décision.');
    }
    const reason = input.reason?.trim() ?? '';
    if (input.decision === 'refuse' && (reason === '' || reason.length > MAX_REASON)) {
      throw new IpcFailure(
        'INVALID_INPUT',
        `Un motif de 1 à ${String(MAX_REASON)} caractères est nécessaire pour refuser.`,
      );
    }
    if (input.head !== (found.pushedHead ?? found.frozenCommit)) {
      throw new IpcFailure('INVALID_INPUT', 'La tête a changé depuis l’affichage : recharge.');
    }
    if (input.decision === 'wait' || input.decision === 'review') {
      return this.answerSilence(workspaceId, found);
    }
    // FR-013 — a CI that is configured and has no green check on this head forbids « Valider ».
    if (
      input.decision === 'validate' &&
      !(found.ci?.verdict === 'green' && found.ci.head === input.head)
    ) {
      throw new IpcFailure(
        'INVALID_INPUT',
        'La CI n’est pas verte sur cette tête : rien à valider.',
      );
    }
    this.deciding.add(found.id);
    try {
      if (input.decision === 'validate') {
        // FR-031 — the CI, the author, the fork, the head and the login are read again in there.
        await this.merge(workspaceId, found.id, true);
        return this.current(workspaceId, found.id);
      }
      await this.save(workspaceId, found.id, { review: { ...found.review, refusedOnce: true } });
      return await this.end(
        workspaceId,
        found.id,
        new Stop(
          'user-refused',
          `Refus de la PR #${String(this.prOf(found).number)} : ${reason}`,
          'user-refused',
          reason,
          !found.unverified,
        ),
      );
    } finally {
      this.deciding.delete(found.id);
    }
  }

  /**
   * « Attendre encore » / « Relire » of a silent CI (FR-016): the silence counts again from now, the item
   * goes and comes back after 10 more minutes if nothing shows. « Relire » says the same to PACT: the PR is
   * opened by the main process (`prUrl`), nothing is merged here. On the alert of the rebases the same answer
   * is « Compris »: the count starts again. A second click on an item already answered changes nothing.
   */
  private async answerSilence(workspaceId: string, found: Delivery): Promise<Delivery> {
    const silent = found.ci?.verdict === 'silent' ? found.ci : null;
    const alerted = found.rebases >= MAX_REBASES_IN_A_ROW;
    if (silent === null && !alerted) return found;
    return this.save(workspaceId, found.id, {
      ...(silent
        ? { ci: { ...silent, emptySince: new Date().toISOString(), verdict: 'pending' as const } }
        : {}),
      ...(alerted ? { rebases: 0 } : {}),
    });
  }

  private async refuseLocal(workspaceId: string, d: Delivery, reason: string | undefined) {
    const saved = await this.save(workspaceId, d.id, {
      state: 'user-refused',
      reason: reason ?? null,
    });
    if (d.issueId !== null) {
      await this.deps.loops.deliveryState(workspaceId, d.issueId, 'accepted');
    }
    await this.tell(
      workspaceId,
      saved,
      'user-refused',
      `Fusion refusée par l’utilisateur · ${this.label(saved)}`,
    );
    return saved;
  }

  /** The states of the integrations started with a `requestId` (R20): the local merge, followed. */
  integrationState(integration: Integration): void {
    if (integration.requestId === undefined) return;
    void this.followIntegration(integration, integration.requestId);
  }

  private async followIntegration(integration: Integration, id: string): Promise<void> {
    const ws = this.deps.workspaces.list().find((w) => w.deliveries.some((d) => d.id === id));
    if (!ws) return;
    const d = this.current(ws.id, id);
    // The word to the orchestrator comes before the state that is read as « all done ».
    if (integration.state === 'integrated') {
      if (d.issueId !== null) await this.deps.loops.deliveryState(ws.id, d.issueId, 'merged');
      await this.tell(
        ws.id,
        d,
        'merged',
        `Fusion locale · ${this.label(d)} · ${short(d.frozenCommit)}`,
        {
          commit: d.frozenCommit,
        },
      );
      await this.save(ws.id, id, { state: 'merged' });
    } else if (['failed', 'blocked', 'cancelled'].includes(integration.state)) {
      const reason = integration.error ?? 'L’intégration n’a pas abouti.';
      await this.tell(
        ws.id,
        d,
        'merge-failed',
        `Fusion locale non faite · ${this.label(d)} · ${reason}`,
      );
      await this.save(ws.id, id, { state: 'reviewing', reason });
    }
  }

  // ---- the CI and the merge (phase 4, US2) ----

  /**
   * « Ouvrir la PR »: the address rebuilt from the GitHub project of the repository and the number
   * of the PR followed, never the stored text; `null` when there is nothing to open.
   */
  async prUrl(deliveryId: string): Promise<string | null> {
    const ws = this.deps.workspaces
      .list()
      .find((w) => w.deliveries.some((d) => d.id === deliveryId));
    const d = ws?.deliveries.find((x) => x.id === deliveryId);
    if (!ws || !d?.pr || d.channel !== 'github') return null;
    let repo: string;
    try {
      repo = await this.repoOf(ws.id);
    } catch {
      return null;
    }
    const [owner, name, ...rest] = repo.split('/');
    const clean = (part: string | undefined) =>
      part !== undefined && /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..';
    if (rest.length > 0 || !clean(owner) || !clean(name)) return null;
    return `https://github.com/${repo}/pull/${String(d.pr.number)}`;
  }

  /** The request, if it is still there. */
  private find(workspaceId: string, id: string): Delivery | undefined {
    return this.deps.workspaces.get(workspaceId)?.deliveries.find((d) => d.id === id);
  }

  private prOf(d: Delivery): { number: number; url: string } {
    const pr = d.pr as NonNullable<Delivery['pr']>;
    return { number: pr.number, url: pr.url };
  }

  /**
   * The CI turned green (FR-010, FR-011): Auto is read now. Auto on, a verdict and no review owed:
   * merge. Otherwise the user is asked, once (FR-012).
   */
  private async onGreen(workspaceId: string, id: string): Promise<void> {
    const d = this.find(workspaceId, id);
    if (!d || d.channel !== 'github' || d.pr === null) return;
    if (d.state !== 'watching' && d.state !== 'reviewing') return;
    const auto = this.workspace(workspaceId).delivery.auto && !d.unverified && !d.review.required;
    if (auto) {
      await this.merge(workspaceId, id);
      return;
    }
    if (d.state === 'reviewing') return;
    const saved = await this.save(workspaceId, id, { state: 'reviewing' });
    await this.tell(
      workspaceId,
      saved,
      'review-requested',
      `Relecture demandée · PR #${String(d.pr.number)}`,
      { pr: this.prOf(saved) },
    );
  }

  /** A check failed: the names go back to the dev for a counted round; with no verdict, only a signal. */
  private async onRed(workspaceId: string, id: string, failing: string[]): Promise<void> {
    const d = this.find(workspaceId, id);
    if (!d?.pr || (d.state !== 'watching' && d.state !== 'reviewing')) return;
    const names = failing.map((name) => `« ${name} »`).join(', ');
    await this.end(
      workspaceId,
      id,
      new Stop(
        'ci-red',
        `La CI de la PR #${String(d.pr.number)} est rouge : ${names} (noms de checks rapportés par la forge). Pour lire le journal d’un check : get_ci_log({ check }). Corrige, commite, puis redemande un verdict.`,
        'ci-red',
        names,
        !d.unverified,
      ),
    );
  }

  /** The head of the PR is not a commit of PACT (FR-004): the request falls, the PR is kept. */
  private async onDropped(workspaceId: string, id: string, head: string): Promise<boolean> {
    const d = this.find(workspaceId, id);
    if (!d || isFinalState(d.state)) return true;
    // A merge under way finishes first; the watcher keeps the request and reads it again.
    if (this.merging.has(id)) return false;
    await this.drop(workspaceId, id, head);
    return true;
  }

  /** Same, for the caller that already holds the merge lock of the request. */
  private async drop(workspaceId: string, id: string, head: string): Promise<void> {
    const d = this.current(workspaceId, id);
    await this.end(
      workspaceId,
      id,
      new Stop(
        'dropped',
        `Le commit ${short(head)} de ${d.branch} n’est pas de PACT.`,
        'dropped',
        `commit ${short(head)} étranger à PACT`,
      ),
    );
  }

  private async onAlert(
    workspaceId: string,
    id: string,
    reason: 'stalled' | 'forge-down',
    checks: string[],
  ): Promise<void> {
    const d = this.find(workspaceId, id);
    if (!d?.pr || isFinalState(d.state)) return;
    const why =
      reason === 'stalled'
        ? `check bloqué, relancé sans succès : ${checks.map((c) => `« ${c} »`).join(', ')}`
        : 'la forge ne répond plus depuis 10 min';
    await this.tell(workspaceId, d, 'alert', `Livraison · PR #${String(d.pr.number)} · ${why}`, {
      pr: this.prOf(d),
      checks,
    });
  }

  /**
   * FR-017 — main moved or a conflict: the PR is rebased on `origin/<target>`, the tests of PACT run on R,
   * R is pushed (lease on the head just read), and a new CI is awaited. No round is counted. A conflict or
   * red tests end the request (`conflicted`, `tests-failed`) with a counted round. `true`: the head moved
   * or the request ended; `false`: nothing to do (already up to date, a merge under way). The lock of the
   * merge is held: neither a merge nor a second rebase meets this one.
   */
  private async onBehind(workspaceId: string, id: string, head: string): Promise<boolean> {
    if (this.merging.has(id)) return false;
    this.merging.add(id);
    try {
      const result = await this.enqueue(workspaceId, () =>
        this.rebaseAfterPr(workspaceId, id, head),
      );
      if (result instanceof Stop) await this.end(workspaceId, id, result);
      return result !== false;
    } finally {
      this.merging.delete(id);
    }
  }

  private async rebaseAfterPr(
    workspaceId: string,
    id: string,
    head: string,
  ): Promise<Stop | boolean> {
    const { git } = this.deps;
    let d = this.current(workspaceId, id);
    const ws = this.workspace(workspaceId);
    // A fetch that fails leaves the old `origin/<target>`: the PR is then already on it, and nothing moves.
    await git.fetchRefs(ws.path, [d.target]);
    const onto = `origin/${d.target}`;
    const rebase = await git.rebaseOnto(ws.path, {
      commit: head,
      onto,
      dir: join(this.deps.deliveriesDir, d.id),
    });
    if (rebase.commit === null) {
      const files = rebase.conflicts.join(', ');
      return new Stop(
        'conflicted',
        `Conflit au recalage sur ${onto} : ${files}. ${this.redo(onto)}`,
        'conflicted',
        files,
        true,
      );
    }
    const rebased = rebase.commit;
    if (rebased === head) return false;
    const red = await this.testsOn(ws, d, rebased);
    if (red) return red;
    // The PR may have changed while the tests ran: the lease fails then, and nothing is lost.
    if (!(await git.pushBranch(ws.path, { commit: rebased, branch: d.branch, expected: head }))) {
      return new Stop(
        'refused',
        `Le push de ${d.branch} est refusé : la branche distante a bougé.`,
        'refused',
      );
    }
    d = await this.save(workspaceId, id, {
      state: 'watching',
      reason: null,
      pactCommits: [...new Set([...d.pactCommits, rebased])],
      verdictCommit: d.unverified ? null : rebased,
      pushedHead: rebased,
      rebases: d.rebases + 1,
    });
    const agent = ws.agents.find((a) => a.id === d.agentId) as Agent;
    await this.catchUp(workspaceId, agent, { ...d, frozenCommit: head }, rebased);
    if (d.rebases === MAX_REBASES_IN_A_ROW) {
      await this.tell(
        workspaceId,
        d,
        'alert',
        `Livraison · PR #${String(this.prOf(d).number)} · ${String(d.rebases)} recalages de suite : main continue de bouger`,
        { pr: this.prOf(d), commit: rebased },
      );
    }
    return true;
  }

  /**
   * R15, FR-032 — the end of the log of a failed check, for the dev of a request whose PR PACT follows.
   * Everything is checked before `gh` is asked for a log: the caller is the dev of the request, the request
   * has not fallen (a red one keeps its PR), the check belongs to the head it was read on and is a failed
   * job of Actions, and the PR is still open, ours and not a fork. Otherwise a refusal, with nothing read.
   */
  async ciLog(
    agentId: string,
    check: string,
  ): Promise<{ check: string; conclusion: string; log: string }> {
    const refuse = (why: string) => new IpcFailure('INVALID_INPUT', why);
    const ws = this.deps.workspaces
      .list()
      .find((w) => w.deliveries.some((d) => d.agentId === agentId));
    const d = ws?.deliveries.filter((x) => x.agentId === agentId).at(-1);
    if (!ws || !d?.pr) throw refuse('Aucune PR suivie pour toi : pas de journal à lire.');
    if (!READ_STATES.includes(d.state) && d.state !== 'ci-red') {
      throw refuse('Ta demande de livraison est terminée ou tombée : pas de journal à lire.');
    }
    const found = d.ci?.checks.find((c) => c.name === checkName(check));
    if (!d.ci || !found) throw refuse('Ce check n’existe pas sur la tête courante de la PR.');
    if (found.job === null || found.status !== 'completed' || found.conclusion !== 'failure') {
      throw refuse('Ce check n’est pas un job GitHub Actions en échec : pas de journal à lire.');
    }
    const gh = this.forge(ws);
    const view = await gh.prView(d.pr.number);
    if (
      view.state !== 'OPEN' ||
      view.isCrossRepository ||
      view.author.login !== d.pr.expectedAuthor ||
      view.headRefName !== d.branch ||
      view.baseRefName !== d.target ||
      view.headRefOid !== d.ci.head ||
      !d.pactCommits.includes(view.headRefOid)
    ) {
      throw refuse('La PR n’est plus celle de PACT : pas de journal à lire.');
    }
    return { check: found.name, conclusion: found.conclusion, log: await gh.jobLog(found.job) };
  }

  /** The PR is no longer open on the forge: merged by someone (FR-036), or closed. */
  private async onClosedOnForge(workspaceId: string, id: string, state: string): Promise<boolean> {
    // A merge under way finishes first; the watcher keeps the request and reads it again.
    if (this.merging.has(id)) return false;
    this.merging.add(id);
    try {
      await this.settleClosed(workspaceId, id, state);
    } finally {
      this.merging.delete(id);
    }
    return true;
  }

  /** Same, for the caller that already holds the merge lock of the request. */
  private async settleClosed(workspaceId: string, id: string, state: string): Promise<void> {
    const d = this.find(workspaceId, id);
    if (!d?.pr || isFinalState(d.state)) return;
    if (state === 'MERGED') {
      await this.merged(workspaceId, id);
      return;
    }
    await this.end(
      workspaceId,
      id,
      new Stop('closed-on-forge', 'La PR a été fermée sur la forge.', 'closed'),
    );
  }

  /** FR-011 — Auto turned on: the PR that wait for a review, green, are merged if everything holds. */
  settingsChanged(workspaceId: string): Promise<void> {
    const ws = this.workspace(workspaceId);
    if (!ws.delivery.auto) return Promise.resolve();
    for (const d of ws.deliveries) {
      if (
        d.channel === 'github' &&
        d.state === 'reviewing' &&
        !d.unverified &&
        !d.review.required &&
        d.ci?.verdict === 'green'
      ) {
        void this.merge(workspaceId, d.id);
      }
    }
    return Promise.resolve();
  }

  /** One merge at a time per request, whoever asks (FR-027). */
  private async merge(workspaceId: string, id: string, decided = false): Promise<void> {
    // Auto does not start a merge while the user is deciding on the same request.
    if (this.merging.has(id) || (!decided && this.deciding.has(id))) return;
    this.merging.add(id);
    try {
      await this.mergeNow(workspaceId, id);
    } catch (error) {
      const d = this.find(workspaceId, id);
      if (d?.pr && !isFinalState(d.state)) {
        const reason =
          error instanceof Error ? error.message.slice(0, MAX_TAIL) : 'Échec inattendu.';
        const saved = await this.save(workspaceId, id, { state: 'merge-failed', reason });
        await this.tell(
          workspaceId,
          saved,
          'alert',
          `Livraison · PR #${String(d.pr.number)} · ${reason}`,
          { pr: this.prOf(saved) },
        );
      }
    } finally {
      this.merging.delete(id);
    }
  }

  /**
   * FR-031 — what is read again just before any merge: the author, the repository of origin, the
   * branches, the head, the verdict and the login of `gh`. A difference: nothing is merged.
   */
  private async recheck(
    gh: Forge,
    d: Delivery,
  ): Promise<
    | { ok: true; head: string }
    | { ok: false; kind: 'state'; state: string }
    | { ok: false; kind: 'dropped'; head: string }
    | { ok: false; kind: 'alert'; reason: string }
  > {
    const pr = d.pr as NonNullable<Delivery['pr']>;
    const view = await gh.prView(pr.number);
    if (view.state !== 'OPEN') return { ok: false, kind: 'state', state: view.state };
    const head = view.headRefOid;
    if (!d.pactCommits.includes(head)) return { ok: false, kind: 'dropped', head };
    const alert = (reason: string) => ({ ok: false as const, kind: 'alert' as const, reason });
    if (view.author.login !== pr.expectedAuthor) {
      return alert('l’auteur de la PR n’est plus le compte attendu.');
    }
    if (view.isCrossRepository) return alert('la PR vient maintenant d’un autre dépôt (fork).');
    if (view.headRefName !== d.branch || view.baseRefName !== d.target) {
      return alert('les branches de la PR ne sont plus celles de la demande.');
    }
    if (d.ci?.verdict !== 'green' || d.ci.head !== head) {
      return alert(`la CI verte lue ne porte pas sur la tête ${short(head)}.`);
    }
    if (!d.unverified && d.verdictCommit !== head) {
      return alert(`le verdict ne porte pas sur la tête ${short(head)}.`);
    }
    const who = await gh.availability();
    if (!who.ok) return alert(`gh n’est plus utilisable : ${who.reason}`);
    if (who.login !== pr.expectedAuthor) return alert('le compte de gh a changé.');
    return { ok: true, head };
  }

  private async mergeNow(workspaceId: string, id: string): Promise<void> {
    const d = this.current(workspaceId, id);
    if (d.channel !== 'github' || d.pr === null) return;
    if (d.state !== 'watching' && d.state !== 'reviewing') return;
    const ws = this.workspace(workspaceId);
    const gh = this.forge(ws);
    const checked = await this.recheck(gh, d);
    if (!checked.ok) {
      if (checked.kind === 'dropped') {
        await this.drop(workspaceId, id, checked.head);
      } else if (checked.kind === 'state') {
        await this.settleClosed(workspaceId, id, checked.state);
      } else {
        const saved = await this.save(workspaceId, id, {
          state: 'merge-failed',
          reason: checked.reason,
        });
        await this.tell(
          workspaceId,
          saved,
          'alert',
          `Livraison · PR #${String(d.pr.number)} · pas de fusion : ${checked.reason}`,
          { pr: this.prOf(saved) },
        );
      }
      return;
    }
    // R2 — written before the call: after a restart, `pr view` says whether it went through.
    await this.save(workspaceId, id, { state: 'merging', reason: null });
    // The mode is the one of the project now; Auto turned off since does not cancel a merge that left.
    const mode = this.workspace(workspaceId).delivery.mergeMode;
    try {
      await gh.prMerge(d.pr.number, mode, checked.head);
    } catch (error) {
      const reason = error instanceof GhFailure ? error.reason : 'gh a échoué.';
      const saved = await this.save(workspaceId, id, { state: 'merge-failed', reason });
      await this.tell(
        workspaceId,
        saved,
        'merge-failed',
        `Fusion refusée par la forge · PR #${String(d.pr.number)} · ${reason}`,
        { pr: this.prOf(saved) },
      );
      return;
    }
    await this.merged(workspaceId, id, mode);
  }

  /**
   * The forge says « merged » (FR-007): the loop is merged and the issue done, the orchestrator is
   * told, then the dev and the tester close. Their worktrees stay: the cleanup has its own rules.
   */
  private async merged(workspaceId: string, id: string, mode?: string): Promise<void> {
    this.watcher.untrack(id);
    const d = this.current(workspaceId, id);
    if (d.state === 'merged') return;
    // The final state comes last: it is read as « all done » (the loop, the word, the agents).
    if (d.issueId !== null && this.deps.loops.get(workspaceId, d.issueId)) {
      await this.deps.loops.deliveryState(workspaceId, d.issueId, 'merged');
    }
    const number = this.prOf(d).number;
    await this.tell(
      workspaceId,
      d,
      'merged',
      `PR #${String(number)} fusionnée${mode === undefined ? '' : ` (${mode})`}`,
      {
        pr: this.prOf(d),
        commit: d.pushedHead ?? d.frozenCommit,
      },
    );
    // A PR without a verdict leaves the agent as it is: its worktree is the user's to clean (FR-039).
    if (!d.unverified) {
      // Closing forgets the tile of an agent: where its worktree is, is noted first (the cleanup needs it).
      const noted = this.workspace(workspaceId).agents.flatMap((a) =>
        (a.id === d.agentId || a.id === d.testAgentId) && a.role !== 'orchestrator'
          ? [
              {
                agentId: a.id,
                role: a.id === d.agentId ? ('dev' as const) : ('test' as const),
                worktreePath: a.worktreePath,
                branch: a.branch,
                baseBranch: a.baseBranch,
                cliId: a.cliId,
                position: a.position,
                name: a.name ?? null,
                color: a.color,
              },
            ]
          : [],
      );
      await this.save(workspaceId, id, { worktrees: noted });
      for (const agentId of [d.agentId, d.testAgentId]) {
        if (agentId === null) continue;
        // Closing an agent that is closed already forgets its tile, and with it where its worktree is:
        // the cleanup (US8) needs the agent, so a closed one is left as it is.
        if (this.workspace(workspaceId).agents.find((a) => a.id === agentId)?.state === 'closed') {
          continue;
        }
        try {
          await this.deps.agents.close(agentId, { removeWorktree: false });
        } catch {
          // An agent that cannot close stays: the merge is done and told.
        }
      }
    }
    // US8 — the cleanup is noted before anything is removed, so that a restart replays it. A PR without a
    // verdict never cleans (FR-039): its worktree is the user's.
    // Nor the PR of someone else, merged on the branch of the dev, nor one the forge cannot be asked about.
    const cleans = !d.unverified && (await this.isOwnPr(workspaceId, d));
    await this.save(workspaceId, id, {
      state: 'merged',
      reason: null,
      cleanup: cleans ? 'pending' : 'none',
    });
    await this.deleteMergedBranch(workspaceId, d);
    if (cleans) await this.worktreeCleanup.run(workspaceId, id);
  }

  /**
   * FR-043 — the remote branch of the merged PR, deleted by ONE push whose lease is the merged head.
   * Only a PR of the expected author, from this repository, on the branch PACT pushed for this
   * request (never the default branch, never a colleague's). Head changed → the branch stays and a
   * `delivery-alert` names the PR and the branch.
   */
  private async deleteMergedBranch(workspaceId: string, d: Delivery): Promise<void> {
    if (d.pr === null) return;
    const ws = this.workspace(workspaceId);
    try {
      const view = await this.forge(ws).prView(d.pr.number);
      const branch = d.branch;
      if (
        view.author.login !== d.pr.expectedAuthor ||
        view.isCrossRepository ||
        view.headRefName !== branch ||
        !d.pactCommits.includes(view.headRefOid)
      ) {
        return;
      }
      const base = await this.deps.git.knownDefaultBranch(ws.path).catch(() => null);
      if (branch === d.target || branch === base?.branch) return;
      if (await this.deps.git.deleteRemoteBranch(ws.path, branch, view.headRefOid)) return;
      // Already gone (or unreachable): nothing to say. Still there: its head moved, it stays.
      const remote = await this.deps.git.remoteBranchHead(ws.path, branch);
      if (remote === null) return;
      await this.save(workspaceId, d.id, { remoteBranchKept: true });
      await this.tell(
        workspaceId,
        d,
        'alert',
        `Livraison · PR #${String(d.pr.number)} · la branche ${branch} reste sur le dépôt distant : sa tête a changé depuis la fusion (${short(view.headRefOid)}).`,
        { pr: this.prOf(d), commit: view.headRefOid },
      );
    } catch {
      // The merge is done and told: a branch that cannot be cleaned stays, nothing more.
    }
  }

  /** The merged PR is the one PACT opened or took over: its author is the expected one (FR-030). */
  private async isOwnPr(workspaceId: string, d: Delivery): Promise<boolean> {
    if (d.pr === null) return false;
    const view = await this.forge(this.workspace(workspaceId))
      .prView(d.pr.number)
      .catch(() => null);
    return view !== null && view.author.login === d.pr.expectedAuthor;
  }

  /**
   * 008 FR-026, US6 sc.6, Q10 — the user closed an agent: the requests it is in (dev or tester) that
   * are not over fall, the PR stays open and untouched, the loop closes and the orchestrator hears
   * it. Called before `LoopService.agentClosed`; a second call finds nothing left to drop. A request
   * that is `merging` is left: the merge was asked, and PACT itself closes the agents when it is done.
   */
  async agentClosed(agentId: string): Promise<void> {
    for (const ws of this.deps.workspaces.list()) {
      const falling = ws.deliveries.filter(
        (d) =>
          (d.agentId === agentId || d.testAgentId === agentId) &&
          !isFinalState(d.state) &&
          d.state !== 'merging' &&
          !this.merging.has(d.id),
      );
      for (const d of falling) {
        await this.end(
          ws.id,
          d.id,
          new Stop(
            'dropped',
            'Un agent de la livraison a été fermé par l’utilisateur : la livraison est abandonnée, la PR reste ouverte.',
            'dropped',
            'agent fermé par l’utilisateur',
            false,
            true,
          ),
        );
      }
    }
  }

  /** The timers of the CI watch stop; the queues are just promises. */
  dispose(): void {
    this.watcher.dispose();
    this.queues.clear();
    this.deciding.clear();
    this.merging.clear();
  }
}
