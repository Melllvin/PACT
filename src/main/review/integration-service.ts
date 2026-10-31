import { randomUUID } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { choicesFor, isFileResolved, parseConflicts, resultOf } from '../../shared/conflicts';
import { IpcFailure } from '../../shared/ipc';
import { WORKING_STATES, type Agent, type AgentState, type Workspace } from '../../shared/model';
import type {
  ConflictChoice,
  ConflictFile,
  Integration,
  IntegrationMode,
} from '../../shared/review';
import { conflictPrompt } from '../../shared/review-prompts';
import {
  LocalChangesError,
  gitErrorOutput,
  type GitService,
  type MergeConflict,
  type MergeResult,
  type Snapshot,
  type TreeEntry,
} from '../git/git-service';

// 002 US2 — an agent's changes into main (research R5): the result computed from objects, the
// commit made with the repository's hooks in a temporary worktree, then main moved once.
// US4 — a conflict stops it before anything is written; it is resolved on the same objects, in
// PACT or by the agent, then ends with the same last step (R6).

type Options = {
  git: Pick<
    GitService,
    | 'snapshot'
    | 'revParse'
    | 'treeOf'
    | 'mergeBase'
    | 'mergeTree'
    | 'lastMainCommit'
    | 'commitWithHooks'
    | 'fastForward'
    | 'updateRef'
    | 'worktreeOf'
    | 'moveWorktree'
    | 'entry'
    | 'readBlob'
    | 'writeBlob'
    | 'replaceInTree'
  >;
  workspaces: { list(): Workspace[] };
  agents: { close(id: string, options: { removeWorktree: boolean }): Promise<void> };
  /** « Demander à l'agent » types its prompt once the agent is ready (R7, FR-028). */
  prompts?: { sendPrompt(agentId: string, text: string): Promise<unknown> };
  /** `<userData>/integrations`: one temporary worktree per integration, removed after. */
  integrationsDir: string;
  /** `<userData>/conflicts`: the copies opened in the user's editor, removed after (R6). */
  conflictsDir?: string;
  /** Opens a file with the application the system associates with it. */
  openPath?: (path: string) => Promise<void>;
  /** How often a copy opened in the editor is read again. */
  watchIntervalMs?: number;
  onState?: (integration: Integration) => void;
};

export type ConflictResolution =
  { path: string; hunk: number; choice: ConflictChoice } | { path: string; content: string };

/** An integration stopped on conflicts: what its end needs, kept until it ends (R6). */
type Pending = {
  integration: Integration;
  request: IntegrationRequest;
  workspaceId: string;
  repo: string;
  /** main the conflicts were found against, the agent's side, and git's merge with markers. */
  main: string;
  tip: string;
  tree: string;
  /** « Demander à l'agent »: the agent started on the prompt since. */
  sawWorking: boolean;
  /** The copies opened in the editor, by path, with what stops reading them. */
  watched: Map<string, () => void>;
};

export type IntegrationRequest = {
  agentId: string;
  mode: IntegrationMode;
  message: string;
  after: Integration['after'];
  confirmWorking?: boolean | undefined;
};

/** main is checked again once when it moved during the integration (FR-022). */
const ATTEMPTS = 2;

class MainMoved extends Error {}

const MAIN_MOVED = 'La branche principale a bougé pendant l’intégration. Réessayer.';
const READY: AgentState[] = ['done', 'awaiting-prompt'];

/** The lines of a text file, without the line break that ends it. */
const linesOf = (text: string | null) =>
  text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n');

/** git's own rule: a NUL byte makes a file binary. */
const isBinary = (text: string | null) => text?.includes('\0') === true;

/**
 * The error an integration ends with, the state it says and the detail kept with it: git's
 * output as it came (FR-021, FR-023), or main moved twice (FR-022).
 */
function failureOf(error: unknown): {
  failure: IpcFailure;
  state: Integration['state'];
  detail: string;
} {
  if (error instanceof MainMoved) {
    return {
      failure: new IpcFailure('MAIN_MOVED', MAIN_MOVED),
      state: 'failed',
      detail: MAIN_MOVED,
    };
  }
  const detail = gitErrorOutput(error);
  if (error instanceof LocalChangesError) {
    return {
      state: 'blocked',
      detail,
      failure: new IpcFailure(
        'LOCAL_CHANGES',
        'Des changements locaux sur la branche principale bloquent l’intégration.',
        undefined,
        error.files,
      ),
    };
  }
  return { state: 'failed', detail, failure: new IpcFailure('GIT_FAILED', detail) };
}

export class IntegrationService {
  private readonly git: Options['git'];
  private readonly onState: NonNullable<Options['onState']>;
  /** One queue per workspace (FR-026). */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: Options) {
    this.git = options.git;
    this.onState = options.onState ?? (() => undefined);
  }

  async start(request: IntegrationRequest): Promise<Integration> {
    const { workspace, agent } = this.find(request.agentId);
    if (WORKING_STATES.includes(agent.state) && request.confirmWorking !== true) {
      throw new IpcFailure('INVALID_INPUT', 'L’agent travaille encore : confirmer l’intégration.');
    }
    // What the user reviewed is what goes in, whatever the agent writes while it waits; the
    // place in the queue is taken at the click too, not once the snapshot is read.
    const snapshot = this.git.snapshot(agent.worktreePath);
    snapshot.catch(() => undefined);
    return this.enqueue(workspace.id, async () => this.integrate(request, await snapshot));
  }

  private enqueue<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(workspaceId) ?? Promise.resolve()).then(task);
    this.queues.set(
      workspaceId,
      result.catch(() => undefined),
    );
    return result;
  }

  private async integrate(
    request: IntegrationRequest,
    snapshot: Snapshot,
    id: string = randomUUID(),
  ): Promise<Integration> {
    // Read again in the queue: the workspace and the agent may have changed while waiting.
    const { workspace, agent } = this.find(request.agentId);
    const repo = workspace.path;
    let integration: Integration = {
      id,
      agentId: agent.id,
      mode: request.mode,
      message: request.message,
      after: request.after,
      snapshot: snapshot.commit,
      mainAtStart: snapshot.commit,
      state: 'checking',
      conflicts: [],
      error: null,
    };
    const set = (change: Partial<Integration>) => {
      integration = { ...integration, ...change };
      const pending = this.pending.get(id);
      if (pending) pending.integration = integration;
      this.onState(integration);
      return integration;
    };
    const dir = join(this.options.integrationsDir, id);
    let next: string;
    try {
      let tip: string | undefined;
      for (let attempt = 1; ; attempt++) {
        const main = await this.git.revParse(repo, workspace.mainBranch);
        set({ mainAtStart: main, state: 'checking' });
        tip ??= await this.agentTip(repo, dir, agent, request, snapshot);
        const merged = await this.git.mergeTree(repo, main, tip);
        if (merged.conflicts.length > 0) {
          const conflicts = await this.conflicts(repo, main, tip, merged);
          this.pending.set(id, {
            integration,
            request,
            workspaceId: workspace.id,
            repo,
            main,
            tip,
            tree: merged.tree,
            sawWorking: false,
            watched: new Map(),
          });
          return set({ state: 'conflicted', conflicts });
        }
        set({ state: 'committing' });
        try {
          next = await this.land(repo, dir, workspace.mainBranch, {
            main,
            tip,
            tree: merged.tree,
            request,
          });
          break;
        } catch (error) {
          // main moved meanwhile: checked once more, then given up (FR-022).
          if (!(error instanceof MainMoved) || attempt === ATTEMPTS) throw error;
        }
      }
    } catch (error) {
      const { failure, state, detail } = failureOf(error);
      set({ state, error: detail });
      throw failure;
    }
    set({ state: 'integrated' });
    // main has moved: what follows never turns the integration into a failure.
    await this.afterwards(agent, integration, next).catch(() => undefined);
    return integration;
  }

  /** « Garder main », « Garder cette version », « Les deux » or a content (FR-029). */
  resolve(id: string, resolution: ConflictResolution): Promise<ConflictFile> {
    // Refusals come back as rejections, as from the other requests.
    return Promise.resolve().then(() => this.applyResolution(id, resolution));
  }

  private applyResolution(id: string, resolution: ConflictResolution): ConflictFile {
    const pending = this.get(id);
    const file = pending.integration.conflicts.find((f) => f.path === resolution.path);
    if (!file) throw new IpcFailure('NOT_FOUND', `« ${resolution.path} » n’est pas en conflit.`);
    let next: ConflictFile;
    if ('content' in resolution) {
      next = { ...file, edited: resolution.content };
    } else {
      const { hunk, choice } = resolution;
      if (!choicesFor(file).includes(choice)) {
        throw new IpcFailure('INVALID_INPUT', 'Ce fichier se garde d’un côté ou de l’autre.');
      }
      if (!file.hunks.some((h) => h.index === hunk)) {
        throw new IpcFailure('NOT_FOUND', 'Conflit inconnu.');
      }
      next = {
        ...file,
        edited: null,
        hunks: file.hunks.map((h) => (h.index === hunk ? { ...h, resolution: choice } : h)),
      };
    }
    next = { ...next, resolved: isFileResolved(next) };
    this.update(pending, {
      conflicts: pending.integration.conflicts.map((f) => (f.path === next.path ? next : f)),
    });
    return next;
  }

  /** A copy of the file as resolved so far, opened in the user's editor and read back (R6). */
  async openInEditor(id: string, path: string): Promise<void> {
    const pending = this.get(id);
    const file = pending.integration.conflicts.find((f) => f.path === path);
    const { conflictsDir, openPath } = this.options;
    if (!file) throw new IpcFailure('NOT_FOUND', `« ${path} » n’est pas en conflit.`);
    if (!conflictsDir || !openPath) throw new IpcFailure('INTERNAL', 'Aucun éditeur disponible.');
    const copy = join(conflictsDir, id, ...path.split('/'));
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, resultOf(file));
    if (!pending.watched.has(path)) {
      const onChange = () => {
        void readFile(copy, 'utf8')
          .then((content) => {
            const current = pending.integration.conflicts.find((f) => f.path === path);
            if (current && content !== resultOf(current))
              return this.resolve(id, { path, content });
          })
          .catch(() => undefined);
      };
      watchFile(copy, { interval: this.options.watchIntervalMs ?? 500 }, onChange);
      pending.watched.set(path, () => {
        unwatchFile(copy, onChange);
      });
    }
    await openPath(copy);
  }

  /** « Demander à l'agent »: the conflict prompt, then checked again when its turn ends (FR-028). */
  async askAgent(id: string): Promise<Integration> {
    const pending = this.get(id);
    const { workspace } = this.find(pending.integration.agentId);
    if (!this.options.prompts) throw new IpcFailure('INTERNAL', 'Aucun agent pour la consigne.');
    await this.options.prompts.sendPrompt(
      pending.integration.agentId,
      conflictPrompt(
        workspace.mainBranch,
        pending.integration.conflicts.map((f) => f.path),
      ),
    );
    pending.sawWorking = false;
    return this.update(pending, { state: 'waiting-agent', error: null });
  }

  /** Follows the agents asked to resolve: their turn over, the integration is checked again. */
  agentState(agentId: string, state: AgentState): void {
    for (const pending of this.pending.values()) {
      const { integration } = pending;
      if (integration.agentId !== agentId || integration.state !== 'waiting-agent') continue;
      if (state === 'working') pending.sawWorking = true;
      else if (state === 'closed') void this.cancel(integration.id);
      else if (READY.includes(state) && pending.sawWorking) {
        const { worktreePath } = this.find(agentId).agent;
        this.drop(pending);
        void this.enqueue(pending.workspaceId, async () =>
          this.integrate(pending.request, await this.git.snapshot(worktreePath), integration.id),
        ).catch(() => undefined);
      }
    }
  }

  /** « Terminer l'intégration »: the resolutions committed, then main moved (FR-030). */
  async finish(id: string): Promise<Integration> {
    const pending = this.get(id);
    if (!pending.integration.conflicts.every((file) => file.resolved)) {
      throw new IpcFailure('INVALID_INPUT', 'Il reste des conflits à résoudre.');
    }
    return this.enqueue(pending.workspaceId, () => this.complete(pending));
  }

  /** « Annuler l'intégration »: nothing was written to main nor to the worktree (FR-031). */
  async cancel(id: string): Promise<void> {
    const pending = this.get(id);
    this.drop(pending);
    this.onState({ ...pending.integration, state: 'cancelled' });
    await this.removeCopies(id);
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      for (const stop of pending.watched.values()) stop();
    }
    this.pending.clear();
  }

  private async complete(pending: Pending): Promise<Integration> {
    const { repo, request, integration } = pending;
    const { workspace, agent } = this.find(integration.agentId);
    const dir = join(this.options.integrationsDir, integration.id);
    let next: string;
    try {
      // The resolutions were made against this main: it must not have moved since.
      const main = await this.git.revParse(repo, workspace.mainBranch);
      if (main !== pending.main) throw new MainMoved();
      const changes = await Promise.all(
        integration.conflicts.map(async (file) => ({
          path: file.path,
          entry: await this.resolvedEntry(pending, file),
        })),
      );
      const tree = await this.git.replaceInTree(repo, pending.tree, changes);
      this.update(pending, { state: 'committing', error: null });
      next = await this.land(repo, dir, workspace.mainBranch, {
        main,
        tip: pending.tip,
        tree,
        request,
      });
    } catch (error) {
      // The resolutions stay: the user fixes what failed and finishes again.
      const { failure } = failureOf(error);
      this.update(pending, { state: 'conflicted', error: failure.message });
      throw failure;
    }
    this.drop(pending);
    await this.removeCopies(integration.id);
    const done = { ...pending.integration, state: 'integrated' as const, error: null };
    this.onState(done);
    await this.afterwards(agent, done, next).catch(() => undefined);
    return done;
  }

  /** The file as resolved: a side kept whole, or the content chosen written as a blob. */
  private async resolvedEntry(pending: Pending, file: ConflictFile): Promise<TreeEntry | null> {
    const { repo } = pending;
    const [hunk] = file.hunks;
    if (file.whole && file.edited === null && hunk?.resolution) {
      return this.git.entry(
        repo,
        hunk.resolution === 'main' ? pending.main : pending.tip,
        file.path,
      );
    }
    const mode = (await this.git.entry(repo, pending.tree, file.path))?.mode ?? '100644';
    return { mode, oid: await this.git.writeBlob(repo, resultOf(file)) };
  }

  /** The commit with the repository's hooks, then main moved; throws MainMoved if it moved. */
  private async land(
    repo: string,
    dir: string,
    branch: string,
    plan: { main: string; tip: string; tree: string; request: IntegrationRequest },
  ) {
    // Everything resolved to main's side: there is nothing left to add to it.
    if (plan.request.mode === 'squash' && plan.tree === (await this.git.treeOf(repo, plan.main))) {
      return plan.main;
    }
    const next = await this.commit(repo, dir, plan);
    await this.moveMain(repo, branch, plan.main, next);
    return next;
  }

  private update(pending: Pending, change: Partial<Integration>): Integration {
    pending.integration = { ...pending.integration, ...change };
    this.onState(pending.integration);
    return pending.integration;
  }

  private get(id: string): Pending {
    const pending = this.pending.get(id);
    if (!pending) throw new IpcFailure('NOT_FOUND', 'Intégration inconnue ou terminée.');
    return pending;
  }

  /** Forgets an integration stopped on conflicts, and stops reading its copies. */
  private drop(pending: Pending) {
    for (const stop of pending.watched.values()) stop();
    this.pending.delete(pending.integration.id);
  }

  private async removeCopies(id: string) {
    const { conflictsDir } = this.options;
    if (!conflictsDir) return;
    await rm(join(conflictsDir, id), { recursive: true, force: true, maxRetries: 5 });
    // The folder of all the copies goes with the last of them.
    await rm(conflictsDir, { recursive: false, force: true }).catch(() => undefined);
  }

  /** The agent's side: its HEAD, plus a commit of its uncommitted changes when keeping commits. */
  private async agentTip(
    repo: string,
    dir: string,
    agent: Agent,
    request: IntegrationRequest,
    snapshot: Snapshot,
  ) {
    if (request.mode === 'squash') return snapshot.commit;
    const head = await this.git.revParse(agent.worktreePath, 'HEAD');
    if ((await this.git.treeOf(agent.worktreePath, head)) === snapshot.tree) return head;
    return this.git.commitWithHooks(repo, {
      dir,
      onto: head,
      tree: snapshot.tree,
      message: request.message,
    });
  }

  private async commit(
    repo: string,
    dir: string,
    plan: { main: string; tip: string; tree: string; request: IntegrationRequest },
  ) {
    const { main, tip, tree, request } = plan;
    const { message } = request;
    if (request.mode === 'squash') {
      return this.git.commitWithHooks(repo, { dir, onto: main, tree, message });
    }
    if ((await this.git.mergeBase(repo, main, tip)) === main) return tip;
    return this.git.commitWithHooks(repo, { dir, onto: main, tree, merge: tip, message });
  }

  /** Where main is checked out, git updates that folder; elsewhere an atomic compare-and-set. */
  private async moveMain(repo: string, branch: string, main: string, next: string) {
    const checkedOut = await this.git.worktreeOf(repo, branch);
    try {
      if (checkedOut === null) await this.git.updateRef(repo, branch, next, main);
      else await this.git.fastForward(checkedOut, next);
    } catch (error) {
      if (error instanceof LocalChangesError) throw error;
      if ((await this.git.revParse(repo, branch)) !== main) throw new MainMoved();
      throw error;
    }
  }

  private async conflicts(
    repo: string,
    main: string,
    tip: string,
    merged: MergeResult,
  ): Promise<ConflictFile[]> {
    const base = await this.git.mergeBase(repo, main, tip);
    return Promise.all(
      merged.conflicts.map((conflict) =>
        this.conflictFile(repo, { base, main, tip }, merged, conflict),
      ),
    );
  }

  /** One file in conflict, with its hunks, or its two sides when it is chosen whole (R6). */
  private async conflictFile(
    repo: string,
    { base, main, tip }: { base: string; main: string; tip: string },
    merged: MergeResult,
    { path, kind }: MergeConflict,
  ): Promise<ConflictFile> {
    const read = async (treeish: string) => {
      const found = await this.git.entry(repo, treeish, path);
      return found ? this.git.readBlob(repo, found.oid) : null;
    };
    const [mainCommit, ours, theirs, result] = await Promise.all([
      this.git.lastMainCommit(repo, base, main, path),
      read(main),
      read(tip),
      read(merged.tree),
    ]);
    const binary = [ours, theirs, result].some(isBinary);
    const hunks = kind === 'content' && !binary && result !== null ? parseConflicts(result) : [];
    const whole = hunks.length === 0;
    return {
      path,
      kind,
      mainCommit: mainCommit ?? { short: main.slice(0, 7), subject: '' },
      hunks: whole
        ? [
            {
              index: 0,
              line: 1,
              main: binary ? [] : linesOf(ours),
              agent: binary ? [] : linesOf(theirs),
              resolution: null,
            },
          ]
        : hunks,
      edited: null,
      resolved: false,
      merged: whole ? '' : (result ?? ''),
      whole,
      binary,
      deleted: ours === null ? 'main' : theirs === null ? 'agent' : null,
    };
  }

  /** FR-024: the tile closed and the worktree removed, or the worktree moved onto main (US2/AC4). */
  private async afterwards(agent: Agent, integration: Integration, next: string) {
    const { closeTile, removeWorktree } = integration.after;
    if (closeTile && removeWorktree) {
      await this.options.agents.close(agent.id, { removeWorktree: true });
      return;
    }
    const worktree = agent.worktreePath;
    const current = await this.git.snapshot(worktree);
    const reviewed = await this.git.treeOf(worktree, integration.snapshot);
    if (current.tree === reviewed) {
      await this.git.moveWorktree(worktree, next, await this.git.treeOf(worktree, next));
    } else {
      // Written after the snapshot: carried over onto main, unless that conflicts.
      const merged = await this.git.mergeTree(worktree, next, current.commit, integration.snapshot);
      if (merged.conflicts.length === 0) await this.git.moveWorktree(worktree, next, merged.tree);
    }
    if (closeTile) await this.options.agents.close(agent.id, { removeWorktree: false });
  }

  private find(agentId: string) {
    for (const workspace of this.options.workspaces.list()) {
      const agent = workspace.agents.find((a) => a.id === agentId);
      if (agent) return { workspace, agent };
    }
    throw new IpcFailure('NOT_FOUND', 'Agent inconnu.');
  }
}
