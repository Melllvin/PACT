import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
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
import { isTestPath, type LoopService } from '../orchestrator/loop-service';
import type { RecordInput } from '../orchestrator/exchange-service';
import { GhFailure, type GhClient } from './gh-client';

// 008 R2 — the delivery of an accepted issue, from the barriers to the pull request: the state of the
// request is written before each effect (data-model), the steps run in a queue per project (like
// `IntegrationService.enqueue`), and every result wakes the orchestrator through the journal (R21).
// The CI watch and the merge come with the next phases.

export type Forge = Pick<GhClient, 'availability' | 'prCreate'>;

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
    | 'addDetached'
    | 'removeDetached'
    | 'moveWorktree'
  >;
  /** One client, or one per repository (`gh` runs in the repository of the project). */
  gh: Forge | ((repoPath: string) => Forge);
  loops: Pick<LoopService, 'reopen' | 'deliveryState' | 'get'>;
  integration: Pick<IntegrationService, 'start'>;
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
  decision: 'validate' | 'refuse';
  head: string;
  reason?: string | undefined;
};

/** The run of a request ends here, with the state it ends in and what to tell. */
class Stop extends Error {
  constructor(
    readonly state: DeliveryState,
    readonly reason: string,
    readonly outcome: 'refused' | 'dropped' | 'conflicted' | 'tests-failed',
    /** What the orchestrator reads after the issue: the commit, the files. */
    readonly detail = '',
    /** `conflicted` and `tests-failed` send the dev back for a counted round. */
    readonly reopen = false,
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

  constructor(private readonly deps: DeliveryServiceDeps) {}

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
      review: { required: unverified, refusedOnce: false },
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
    // `run` ends its request itself; a failure of that very write is all that can reach here.
    this.enqueue(workspaceId, () => this.run(workspaceId, delivery.id, login)).catch(
      () => undefined,
    );
    return this.current(workspaceId, delivery.id);
  }

  /**
   * The head PACT last pushed to this branch and did not delete since: the lease of a new request
   * after one that pushed and then stopped (a PR that failed to open, for instance).
   */
  private lastPush(workspaceId: string, d: Delivery): string | null {
    return (
      this.workspace(workspaceId)
        .deliveries.filter(
          (x) =>
            x.id !== d.id && x.branch === d.branch && x.pushedHead !== null && x.cleanup !== 'done',
        )
        .at(-1)?.pushedHead ?? null
    );
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
    const { git } = this.deps;
    let d = await this.save(workspaceId, id, { state: 'syncing' });
    const ws = this.workspace(workspaceId);
    const gh = this.forge(ws);
    const agent = ws.agents.find((a) => a.id === d.agentId) as Agent;
    await this.ensureHead(agent, d);

    if (!(await git.fetchRefs(ws.path, [d.target]))) {
      throw new Stop('refused', 'Le dépôt distant est injoignable (fetch).', 'refused');
    }
    const onto = `origin/${d.target}`;
    const redo = `Recale ta branche sur ${onto} (git rebase ${onto}), résous les conflits, commite, puis redemande un verdict.`;
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
          `Recalage impossible sur ${onto} : ${why}. ${redo}`,
          'conflicted',
          'recalage impossible',
          true,
        );
      });
    if (rebase.commit === null) {
      const files = rebase.conflicts.join(', ');
      throw new Stop(
        'conflicted',
        `Conflit au recalage sur ${onto} : ${files}. ${redo}`,
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

    const dir = join(this.deps.deliveriesDir, d.id);
    await git.addDetached(ws.path, dir, rebased);
    try {
      const command = ws.testCommand ?? (await detectTestCommandIn(dir));
      if (command !== null) {
        const run = await this.deps.runTests(dir, command);
        if (!run.passed) {
          throw new Stop(
            'tests-failed',
            `Tests rouges sur ${short(rebased)}${run.tail ? ` : ${run.tail.slice(-MAX_TAIL)}` : ''}`,
            'tests-failed',
            short(rebased),
            true,
          );
        }
      }
    } finally {
      await git.removeDetached(ws.path, dir);
    }
    await this.ensureHead(agent, d);

    d = await this.save(workspaceId, id, { state: 'pushing' });
    if (
      !(await git.pushBranch(ws.path, {
        commit: rebased,
        branch: d.branch,
        expected: d.pushedHead ?? this.lastPush(workspaceId, d),
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
    try {
      pr = await gh.prCreate({
        head: d.branch,
        base: d.target,
        title: d.title,
        body: prBody({
          issue: issue
            ? { id: issue.id, remote: issue.remote, text: await this.issueText(agent, issue.path) }
            : null,
          message: d.message,
          verdict:
            tester === null || d.unverified
              ? null
              : { result: 'accepted', commit: rebased, tester },
        }),
      });
    } catch (error) {
      throw new Stop(
        'refused',
        error instanceof GhFailure ? error.reason : 'gh a échoué.',
        'refused',
      );
    }
    d = await this.save(workspaceId, id, {
      pr: { number: pr.number, url: pr.url, expectedAuthor: login },
    });
    await this.tell(
      workspaceId,
      d,
      'pr-opened',
      `PR #${String(pr.number)} ouverte · ${this.label(d)} · ${short(rebased)}`,
      {
        pr: { number: pr.number, url: pr.url },
        commit: rebased,
      },
    );
    await this.catchUp(workspaceId, agent, d, rebased);
    await this.save(workspaceId, id, { state: 'watching' });
  }

  /** The head of the dev is still F: a commit PACT did not make drops the request (R6). */
  private async ensureHead(agent: Agent, d: Delivery): Promise<void> {
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
    // The loop and the word to the orchestrator come first: a final state is read as « all done ».
    let d = this.current(workspaceId, id);
    const issue = d.issueId;
    const loop = issue === null ? null : this.deps.loops.get(workspaceId, issue);
    let text: string;
    if (stop.outcome === 'refused') {
      text = `Livraison refusée · ${this.label(d)} · ${stop.reason}`;
      // The verdict and the proof still stand: the loop is as it was.
      if (loop?.state === 'delivering') {
        await this.deps.loops.deliveryState(workspaceId, loop.issueId, 'accepted');
      }
    } else if (stop.outcome === 'dropped') {
      text = `Livraison tombée · ${this.label(d)} · ${stop.detail}`;
      if (loop) await this.deps.loops.deliveryState(workspaceId, loop.issueId, 'running');
    } else {
      const reopened =
        loop && stop.reopen
          ? await this.deps.loops.reopen(workspaceId, loop.issueId, stop.reason)
          : null;
      const what =
        stop.outcome === 'conflicted'
          ? `Conflit au recalage · ${this.label(d)} · ${stop.detail}`
          : `Tests rouges sur ${stop.detail} · ${this.label(d)}`;
      text =
        reopened === null
          ? what
          : reopened.state === 'escalated'
            ? `${what} : plafond atteint, l’utilisateur décide`
            : `${what} : tour ${String(reopened.round)} ouvert`;
    }
    await this.tell(workspaceId, d, stop.outcome, text);
    d = await this.save(workspaceId, id, { state: stop.state, reason: stop.reason });
    return d;
  }

  /** The orchestrator hears of a result (R21); a project without one has nobody to tell. */
  private async tell(
    workspaceId: string,
    d: Delivery,
    outcome: NonNullable<ExchangeMessage['delivery']>['outcome'],
    text: string,
    extra: { pr?: { number: number; url: string }; commit?: string } = {},
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
    if (found.state !== 'reviewing' || found.channel !== 'local') {
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
    if (integration.state === 'integrated') {
      const saved = await this.save(ws.id, id, { state: 'merged' });
      if (saved.issueId !== null) {
        await this.deps.loops.deliveryState(ws.id, saved.issueId, 'merged');
      }
      await this.tell(
        ws.id,
        saved,
        'merged',
        `Fusion locale · ${this.label(saved)} · ${short(saved.frozenCommit)}`,
        {
          commit: saved.frozenCommit,
        },
      );
    } else if (['failed', 'blocked', 'cancelled'].includes(integration.state)) {
      const reason = integration.error ?? 'L’intégration n’a pas abouti.';
      const saved = await this.save(ws.id, id, { state: 'reviewing', reason });
      await this.tell(
        ws.id,
        saved,
        'merge-failed',
        `Fusion locale non faite · ${this.label(d)} · ${reason}`,
      );
    }
  }

  /** Nothing runs by itself between two requests: the queue is just promises. */
  dispose(): void {
    this.queues.clear();
    this.deciding.clear();
  }
}
