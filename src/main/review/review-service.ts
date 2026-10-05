import { randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { IpcFailure, type IpcEvent, type IpcInput } from '../../shared/ipc';
import type { Agent, AgentReview, ReviewComment, Workspace } from '../../shared/model';
import { seenBlob, type FileDiff, type ReviewSnapshot, type TestRun } from '../../shared/review';
import { reviewPrompt, type ReviewPrompt } from '../../shared/review-prompts';
import type { GitService } from '../git/git-service';
import { detectTestCommandIn, type TestTarget } from './test-runner';

// 002 US1 — an agent's changes against main, followed while the worktree changes
// (research R1–R3), with the files marked « vu » kept per agent (R9, FR-009, FR-011).
// US3 — comments and instructions typed into the agent's prompt (R7, FR-012…FR-015).

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
    | 'mergeTree'
  >;
  workspaces: WorkspaceAccess;
  /** Types a prompt once the agent is ready for one (R7, FR-014). */
  agents: { sendPrompt(id: string, text: string): Promise<void> };
  tests: { latest(agentId: string): TestRun | null };
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
  private readonly agents: Options['agents'];
  private readonly tests: Options['tests'];
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
    this.agents = options.agents;
    this.tests = options.tests;
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
    await this.updateReview(workspace.id, agentId, (review) => {
      const next = Object.fromEntries(
        Object.entries(review.seen).filter(([seenPath]) => seenPath !== path),
      );
      if (seen && file) next[path] = seenBlob(file);
      return { ...review, seen: next };
    });
    if (this.followed.has(agentId)) await this.refresh(agentId, true);
  }

  /** Keeps the comment under its line and types it for the agent (FR-012). */
  async comment(agentId: string, path: string, line: number, text: string): Promise<ReviewComment> {
    const { workspace } = this.find(agentId);
    const comment: ReviewComment = {
      id: randomUUID(),
      path,
      line,
      text,
      createdAt: new Date().toISOString(),
      treated: false,
    };
    await this.updateReview(workspace.id, agentId, (review) => ({
      ...review,
      comments: [...review.comments, comment],
    }));
    await this.agents.sendPrompt(agentId, reviewPrompt({ kind: 'comment', path, line, text }));
    return comment;
  }

  /** The shortcuts above the terminal and « Renvoyer à l'agent » (FR-013, FR-015). */
  async send(request: IpcInput<'review:send'>): Promise<void> {
    const { agentId } = request;
    const { workspace, agent } = this.find(agentId);
    const refuse = (message: string) => new IpcFailure('INVALID_INPUT', message);
    let prompt: ReviewPrompt;
    switch (request.kind) {
      case 'fix-comments': {
        const comments = agent.review.comments.filter((c) => !c.treated);
        if (comments.length === 0) throw refuse('Aucun commentaire à corriger.');
        await this.agents.sendPrompt(agentId, reviewPrompt({ kind: 'fix-comments', comments }));
        const sent = new Set(comments.map((c) => c.id));
        await this.updateReview(workspace.id, agentId, (review) => ({
          ...review,
          comments: review.comments.map((c) => (sent.has(c.id) ? { ...c, treated: true } : c)),
        }));
        return;
      }
      case 'failing-tests': {
        const run = this.tests.latest(agentId);
        if (run?.status !== 'failed') throw refuse('Aucun test en échec.');
        prompt = { kind: 'failing-tests', command: run.command, output: run.outputTail };
        break;
      }
      case 'conflict': {
        // Checked now: main may have moved since the review was shown.
        const { conflicts } = await this.compute(agentId);
        if (!Array.isArray(conflicts) || conflicts.length === 0) {
          throw refuse(`Aucun conflit avec ${workspace.mainBranch}.`);
        }
        prompt = { kind: 'conflict', mainBranch: workspace.mainBranch, files: conflicts };
        break;
      }
      case 'request':
        if (request.text.trim() === '') throw refuse('La demande est vide.');
        prompt = { kind: 'request', text: request.text };
    }
    await this.agents.sendPrompt(agentId, reviewPrompt(prompt));
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

  /** What the tests of an agent run: its worktree and port, the command, the tree shown (R8). */
  async testPlan(
    agentId: string,
  ): Promise<{ target: TestTarget; command: string | null; tree: string }> {
    const { workspace, agent } = this.find(agentId);
    const cwd = agent.worktreePath;
    return {
      target: { agentId, cwd, port: agent.port },
      command: await testCommand(workspace, cwd),
      tree: this.snapshots.get(agentId)?.tree ?? (await this.git.snapshot(cwd)).tree,
    };
  }

  dispose(): void {
    for (const agentId of [...this.followed.keys()]) this.close(agentId);
    this.snapshots.clear();
    this.wanted.clear();
  }

  private async updateReview(
    workspaceId: string,
    agentId: string,
    change: (review: AgentReview) => AgentReview,
  ) {
    await this.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === agentId ? { ...a, review: change(a.review) } : a)),
    }));
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
      const [mainHead, base, { commit, tree }, branch] = await Promise.all([
        this.git.revParse(cwd, workspace.mainBranch),
        this.git.mergeBase(cwd, workspace.mainBranch, 'HEAD'),
        this.git.snapshot(cwd),
        this.git.currentBranch(cwd),
      ]);
      const [files, merged] = await Promise.all([
        this.git.changedFiles(cwd, base, tree),
        // Checked on each snapshot: main moving changes `mainHead`, so the review is sent again.
        this.git.mergeTree(cwd, mainHead, commit),
      ]);
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
        conflicts: merged.conflicts.length > 0 ? merged.conflicts.map((c) => c.path) : 'none',
        mainHead,
        newSinceSeen: await this.newSinceSeen(cwd, agent, files),
        missing: false,
        testCommand: await testCommand(workspace, cwd),
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
    testCommand: null,
  };
}

/** The command set for the workspace, else the one detected in the worktree (R8). */
async function testCommand(workspace: Workspace, cwd: string) {
  return workspace.testCommand ?? (await detectTestCommandIn(cwd));
}
