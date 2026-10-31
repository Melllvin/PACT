import { randomUUID } from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { IpcFailure, type IpcEvent } from '../../shared/ipc';
import type { Agent, ReviewComment, Workspace } from '../../shared/model';
import { seenBlob, type FileDiff, type ReviewSnapshot, type TestRun } from '../../shared/review';
import {
  commentPrompt,
  conflictPrompt,
  failingTestsPrompt,
  fixCommentsPrompt,
  requestPrompt,
} from '../../shared/review-prompts';
import type { GitService } from '../git/git-service';
import { detectTestCommandIn, type TestTarget } from './test-runner';

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
    | 'mergeTree'
  >;
  workspaces: WorkspaceAccess;
  onChanged?: (snapshot: ReviewSnapshot) => void;
  onPending?: (event: IpcEvent<'review:pending'>) => void;
  /** Types a prompt once the agent is ready for one, never as an answer (R7, FR-014). */
  prompts?: { sendPrompt(agentId: string, text: string): Promise<unknown> };
  /** The last test run of each agent, for « Tests en échec ». */
  tests?: { latest(agentId: string): TestRun | null };
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

/** What a shortcut of the review sends (FR-013, FR-015). */
export type ReviewSend =
  { kind: 'fix-comments' | 'failing-tests' | 'conflict' } | { kind: 'request'; text: string };

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
  private readonly prompts: Options['prompts'];
  private readonly tests: Options['tests'];
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
    this.prompts = options.prompts;
    this.tests = options.tests;
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
    await this.changeReview(workspace.id, agentId, (review) => {
      const next = Object.fromEntries(
        Object.entries(review.seen).filter(([seenPath]) => seenPath !== path),
      );
      if (seen && file) next[path] = seenBlob(file);
      return { ...review, seen: next };
    });
    if (this.followed.has(agentId)) await this.refresh(agentId, true);
  }

  /** A comment on one line, saved with the agent and typed to it as a prompt (FR-012). */
  async comment(
    agentId: string,
    { path, line, text }: Pick<ReviewComment, 'path' | 'line' | 'text'>,
  ): Promise<ReviewComment> {
    const { workspace } = this.find(agentId);
    const comment: ReviewComment = {
      id: randomUUID(),
      path,
      line,
      text: text.trim(),
      createdAt: new Date().toISOString(),
      treated: false,
    };
    await this.changeReview(workspace.id, agentId, (review) => ({
      ...review,
      comments: [...review.comments, comment],
    }));
    await this.prompt(agentId, commentPrompt(comment));
    return comment;
  }

  /** The shortcuts above the terminal and « Renvoyer à l'agent » (FR-013, FR-015). */
  async send(agentId: string, request: ReviewSend): Promise<void> {
    const { workspace, agent } = this.find(agentId);
    switch (request.kind) {
      case 'request': {
        const text = requestPrompt(request.text);
        if (text === '') throw new IpcFailure('INVALID_INPUT', 'Demande vide.');
        await this.prompt(agentId, text);
        return;
      }
      case 'fix-comments': {
        const open = agent.review.comments.filter((comment) => !comment.treated);
        if (open.length === 0)
          throw new IpcFailure('INVALID_INPUT', 'Aucun commentaire à corriger.');
        await this.prompt(agentId, fixCommentsPrompt(open));
        const ids = new Set(open.map((comment) => comment.id));
        await this.changeReview(workspace.id, agentId, (review) => ({
          ...review,
          comments: review.comments.map((c) => (ids.has(c.id) ? { ...c, treated: true } : c)),
        }));
        return;
      }
      case 'failing-tests': {
        const run = this.tests?.latest(agentId);
        if (run?.status !== 'failed' && run?.status !== 'timeout') {
          throw new IpcFailure('INVALID_INPUT', 'Aucun test en échec.');
        }
        await this.prompt(agentId, failingTestsPrompt(run.command, run.outputTail));
        return;
      }
      case 'conflict': {
        // Read again: main may have moved since the review was shown.
        const { conflicts } = await this.compute(agentId);
        if (!Array.isArray(conflicts)) {
          throw new IpcFailure('INVALID_INPUT', `Aucun conflit avec ${workspace.mainBranch}.`);
        }
        await this.prompt(agentId, conflictPrompt(workspace.mainBranch, conflicts));
        return;
      }
    }
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

  private async prompt(agentId: string, text: string) {
    if (!this.prompts) throw new IpcFailure('INTERNAL', 'Aucun agent pour recevoir la consigne.');
    await this.prompts.sendPrompt(agentId, text);
  }

  private async changeReview(
    workspaceId: string,
    agentId: string,
    change: (review: Agent['review']) => Agent['review'],
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
