import { access } from 'node:fs/promises';
import type { Delivery } from '../../shared/delivery';
import type { Agent, Workspace } from '../../shared/model';
import type { GitService } from '../git/git-service';
import { isTestPath } from '../orchestrator/loop-service';

// 008 R17 (US8, FR-034 to FR-042) — the worktrees no longer pile up. When the forge says « merged » for a
// PR that PACT followed with a verdict, the worktree of the dev and the one of the tester are removed IF
// nothing in them is lost; the orchestrator never is. The conditions are read again right before each
// removal (FR-042); the removal is `git worktree remove` WITHOUT `--force` (git itself refuses a modified
// or untracked file, a second guard); only the branch of the dev is deleted, and only while its tip is
// still the merged head. « Merged » is the word of the forge (`state` and `headRefOid` of the PR), never
// the ancestry of a branch: a squash leaves the branch of the dev out of `main`.

type Role = 'dev' | 'test';

export type Kept = { agentId: string; reason: string };

export type CleanupDeps = {
  workspaces: {
    get(id: string): Workspace | undefined;
    list(): Workspace[];
  };
  git: Pick<
    GitService,
    | 'revParse'
    | 'treeOf'
    | 'mergeBase'
    | 'changedFiles'
    | 'entry'
    | 'statusIgnored'
    | 'commitsNotIn'
    | 'removeWorktreeDir'
    | 'deleteBranch'
  >;
  /** The head of the PR when it was merged, as the forge says it; `null` when it cannot be read. */
  mergedHead(workspace: Workspace, delivery: Delivery): Promise<string | null>;
  /** The request as written before the next effect (and told to the renderer). */
  save(workspaceId: string, deliveryId: string, change: Partial<Delivery>): Promise<unknown>;
};

/** What the conditions say about one worktree, read now. */
type Reading =
  | { kind: 'clear' }
  /** The agent is open again (FR-042) or gone: nothing to remove, nothing to ask. */
  | { kind: 'open' }
  | { kind: 'gone' }
  | { kind: 'doubt'; reasons: string[]; lost: string[] };

const isDirectory = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const errorText = (error: unknown): string => {
  const failure = error as { stderr?: unknown; message?: unknown };
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  const text = stderr || (typeof failure.message === 'string' ? failure.message : 'erreur de git');
  return text.slice(0, 500);
};

const plural = (count: number, word: string) => `${String(count)} ${word}${count > 1 ? 's' : ''}`;

export class WorktreeCleanup {
  /** A cleanup in progress, by request: a second one (a restart, a click) finds it taken. */
  private readonly running = new Set<string>();

  constructor(private readonly deps: CleanupDeps) {}

  /**
   * The cleanup of a merged request whose `cleanup` is `pending` (written before anything is removed,
   * so that a restart replays it). Everything that is not certain is kept and said; nothing throws.
   */
  async run(workspaceId: string, deliveryId: string): Promise<void> {
    if (this.running.has(deliveryId)) return;
    this.running.add(deliveryId);
    try {
      await this.cleanAll(workspaceId, deliveryId);
    } finally {
      this.running.delete(deliveryId);
    }
  }

  private async cleanAll(workspaceId: string, deliveryId: string): Promise<void> {
    const ws = this.deps.workspaces.get(workspaceId);
    const d = ws?.deliveries.find((candidate) => candidate.id === deliveryId);
    if (!ws || !d || d.state !== 'merged' || d.cleanup !== 'pending') return;
    const head = await this.deps.mergedHead(ws, d).catch(() => null);
    const kept: Kept[] = [];
    let open = false;
    for (const [agentId, role] of [
      [d.agentId, 'dev'],
      [d.testAgentId, 'test'],
    ] as const) {
      const agent = agentId === null ? undefined : this.agentOf(ws.id, d.id, agentId);
      // The orchestrator is never touched, whatever the request says.
      if (!agent || agent.role === 'orchestrator') continue;
      try {
        if (head === null) {
          // The state of an agent that is open is not a doubt to ask about.
          const fresh = this.agentOf(ws.id, d.id, agent.id);
          if (fresh?.state === 'closed')
            kept.push({ agentId: agent.id, reason: 'tête de la PR illisible' });
          else open = true;
          continue;
        }
        const outcome = await this.clean(ws, d, agent, role, head);
        if (outcome === null) continue;
        if ('open' in outcome) open = true;
        else kept.push({ agentId: agent.id, reason: outcome.kept });
      } catch (error) {
        kept.push({ agentId: agent.id, reason: errorText(error) });
      }
    }
    await this.conclude(workspaceId, deliveryId, kept, open);
  }

  /** `null`: removed (or nothing to remove); `open`: the agent works again; else the reason it was kept. */
  private async clean(
    ws: Workspace,
    d: Delivery,
    agent: Agent,
    role: Role,
    head: string,
  ): Promise<{ open: true } | { kept: string } | null> {
    const first = await this.read(ws, d, agent, role, head);
    if (first.kind === 'open') return { open: true };
    if (first.kind === 'gone') return null;
    if (first.kind === 'doubt') return { kept: first.reasons.join(', ') };
    // FR-042 — read again, as close to the removal as possible.
    const again = await this.read(ws, d, agent, role, head);
    if (again.kind === 'open') return { open: true };
    if (again.kind === 'gone') return null;
    if (again.kind === 'doubt') return { kept: again.reasons.join(', ') };
    try {
      await this.deps.git.removeWorktreeDir(ws.path, agent.worktreePath);
    } catch (error) {
      return { kept: errorText(error) };
    }
    if (role !== 'dev') return null;
    // The branch is the dev's alone, and only while it is still what was merged.
    const tip = await this.branchTip(ws, agent);
    if (tip === null) return null;
    if (tip !== head) return { kept: 'la branche du dev a avancé depuis la fusion' };
    try {
      await this.deps.git.deleteBranch(ws.path, agent.branch);
    } catch (error) {
      return { kept: errorText(error) };
    }
    return null;
  }

  /**
   * The agent as it is now. Closing an agent forgets its tile: then the worktree noted at the merge stands
   * for it, as a closed agent (nothing runs in it any more).
   */
  private agentOf(workspaceId: string, deliveryId: string, agentId: string): Agent | undefined {
    const ws = this.deps.workspaces.get(workspaceId);
    const listed = ws?.agents.find((a) => a.id === agentId);
    if (listed) return listed;
    const noted = ws?.deliveries
      .find((d) => d.id === deliveryId)
      ?.worktrees?.find((w) => w.agentId === agentId);
    return noted
      ? ({ ...noted, id: noted.agentId, state: 'closed', role: noted.role } as unknown as Agent)
      : undefined;
  }

  private async branchTip(ws: Workspace, agent: Agent): Promise<string | null> {
    return this.deps.git.revParse(ws.path, `refs/heads/${agent.branch}`).catch(() => null);
  }

  /** R17 table: the conditions of the dev and of the tester, read now from the disk and the saved agent. */
  private async read(
    ws: Workspace,
    d: Delivery,
    saved: Agent,
    role: Role,
    head: string,
  ): Promise<Reading> {
    const agent = this.agentOf(ws.id, d.id, saved.id);
    if (!agent) return { kind: 'gone' };
    if (agent.state !== 'closed') return { kind: 'open' };
    const { git } = this.deps;
    const reasons: string[] = [];
    const lost: string[] = [];
    const found = await isDirectory(agent.worktreePath);
    if (found) {
      const status = await git.statusIgnored(agent.worktreePath);
      for (const file of status.modified) {
        reasons.push(`${file} modifié`);
        lost.push(`${file} (modifié)`);
      }
      for (const file of status.untracked) {
        reasons.push(`${file} non suivi`);
        lost.push(`${file} (non suivi)`);
      }
      for (const file of status.ignoredEnv) {
        reasons.push(`${file} ignoré (.env)`);
        lost.push(`${file} (ignoré)`);
      }
    }
    if (role === 'dev') {
      // The folder has the head it is on; without the folder, only the branch can hold commits.
      const at = found
        ? await git.revParse(agent.worktreePath, 'HEAD').catch(() => null)
        : await this.branchTip(ws, agent);
      if (at !== null && at !== head) {
        const subjects = await git.commitsNotIn(ws.path, at, head).catch(() => null);
        if (subjects === null) {
          reasons.push('commits non vérifiables : la tête de la PR est inconnue ici');
          lost.push('commits non vérifiables');
        } else if (subjects.length > 0) {
          const count = plural(subjects.length, 'commit');
          reasons.push(`${count} absent${subjects.length > 1 ? 's' : ''} de la PR`);
          lost.push(
            `${count} absent${subjects.length > 1 ? 's' : ''} de la PR : ${subjects.join(', ')}`,
          );
        } else {
          reasons.push('la tête du dev n’est pas la tête de la PR');
        }
      }
    } else if (found) {
      const missing = await this.testsMissing(ws, agent, head);
      for (const file of missing) {
        reasons.push(`${file} absent de la PR`);
        lost.push(`${file} (test absent de la PR)`);
      }
    }
    return reasons.length === 0 ? { kind: 'clear' } : { kind: 'doubt', reasons, lost };
  }

  /**
   * R4 / R17 — the test files the tester changed since its real bases that the merged head does not hold
   * identically (same blob and mode, or absent from both): « contained » is read by content, not by history.
   */
  private async testsMissing(ws: Workspace, tester: Agent, head: string): Promise<string[]> {
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
    // No base to compare with: nothing can be said to be contained.
    if (files === null)
      throw new Error('les tests du testeur ne peuvent pas être comparés à la PR');
    const missing: string[] = [];
    for (const path of files) {
      const [theirs, mine] = await Promise.all([
        git.entry(tester.worktreePath, testerHead, path),
        git.entry(ws.path, head, path),
      ]);
      if (theirs?.oid !== mine?.oid || theirs?.mode !== mine?.mode) missing.push(path);
    }
    return missing;
  }

  /** The end of the cleanup: what is kept and why, or done. An agent that is open again ends it as « none ». */
  private async conclude(
    workspaceId: string,
    deliveryId: string,
    kept: Kept[],
    open: boolean,
  ): Promise<void> {
    const ws = this.deps.workspaces.get(workspaceId);
    const label = (agentId: string) =>
      ws?.deliveries.find((d) => d.id === deliveryId)?.agentId === agentId ? 'dev' : 'testeur';
    await this.deps.save(workspaceId, deliveryId, {
      cleanup: kept.length > 0 ? 'kept' : open ? 'none' : 'done',
      reason:
        kept.length > 0 ? kept.map((k) => `${label(k.agentId)} : ${k.reason}`).join(' ; ') : null,
      kept,
    });
  }

  private locate(deliveryId: string, agentId: string) {
    for (const ws of this.deps.workspaces.list()) {
      const delivery = ws.deliveries.find((d) => d.id === deliveryId);
      if (!delivery) continue;
      const role: Role | null =
        delivery.agentId === agentId ? 'dev' : delivery.testAgentId === agentId ? 'test' : null;
      const agent = this.agentOf(ws.id, delivery.id, agentId);
      if (role === null || !agent || agent.role === 'orchestrator') return null;
      if (!(delivery.kept ?? []).some((k) => k.agentId === agentId)) return null;
      return { ws, delivery, agent, role };
    }
    return null;
  }

  /**
   * « Supprimer quand même », first step: what the removal would lose now, as short lines (modified and
   * untracked files, ignored `.env*`, commits the PR does not hold). `null` for a request or an agent
   * that has no kept worktree. Nothing is removed.
   */
  async lost(deliveryId: string, agentId: string): Promise<string[] | null> {
    const found = this.locate(deliveryId, agentId);
    if (!found) return null;
    const head = await this.deps.mergedHead(found.ws, found.delivery);
    if (head === null)
      return ['la tête de la PR est illisible : les commits ne peuvent pas être comptés'];
    const reading = await this.read(found.ws, found.delivery, found.agent, found.role, head);
    if (reading.kind === 'open')
      throw new Error('L’agent a été rouvert : son worktree n’est pas supprimé.');
    return reading.kind === 'doubt' ? reading.lost : [];
  }

  /**
   * « Supprimer quand même », confirmed (the user read `lost()`): the removal with `--force`, then the
   * branch of the dev. An agent that is open again is never removed. A failure is thrown: the user reads why.
   */
  async force(deliveryId: string, agentId: string): Promise<void> {
    const found = this.locate(deliveryId, agentId);
    if (!found) throw new Error('Ce worktree n’est plus à supprimer.');
    const { ws, agent, role } = found;
    if (this.agentOf(ws.id, deliveryId, agent.id)?.state !== 'closed') {
      throw new Error('L’agent a été rouvert : son worktree n’est pas supprimé.');
    }
    await this.deps.git.removeWorktreeDir(ws.path, agent.worktreePath, true);
    if (role === 'dev' && (await this.branchTip(ws, agent)) !== null) {
      await this.deps.git.deleteBranch(ws.path, agent.branch);
    }
    await this.settle(ws.id, deliveryId, agentId);
  }

  /** « Garder »: the worktree stays as it is and the item goes. */
  async keep(deliveryId: string, agentId: string): Promise<void> {
    const found = this.locate(deliveryId, agentId);
    if (found) await this.settle(found.ws.id, deliveryId, agentId);
  }

  /** The agent is no longer kept: when it was the last one, the cleanup is over. */
  private async settle(workspaceId: string, deliveryId: string, agentId: string): Promise<void> {
    const d = this.deps.workspaces
      .get(workspaceId)
      ?.deliveries.find((candidate) => candidate.id === deliveryId);
    if (!d) return;
    const rest = (d.kept ?? []).filter((k) => k.agentId !== agentId);
    const dev = d.agentId;
    await this.deps.save(workspaceId, deliveryId, {
      kept: rest,
      cleanup: rest.length > 0 ? 'kept' : 'done',
      reason:
        rest.length > 0
          ? rest.map((k) => `${k.agentId === dev ? 'dev' : 'testeur'} : ${k.reason}`).join(' ; ')
          : null,
    });
  }
}
