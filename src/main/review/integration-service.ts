import { randomUUID } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

/** What `<integrationsDir>/<id>.json` holds: a `Pending` without its follow-up functions (R19). */
type StoredPending = Pick<
  Pending,
  'integration' | 'request' | 'workspaceId' | 'repo' | 'main' | 'tip' | 'tree'
>;

/** The files of the integrations: a UUID and `.json`, nothing else is read. */
const FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

export type IntegrationRequest = {
  agentId: string;
  mode: IntegrationMode;
  message: string;
  after: Integration['after'];
  confirmWorking?: boolean | undefined;
  /** 008 R20 — the delivery that asks for it: its states carry the id. */
  requestId?: string | undefined;
};

/** main is checked again once when it moved during the integration (FR-022). */
const ATTEMPTS = 2;

class MainMoved extends Error {}

/** Cancelled by the user while it was checked again: nothing more is written. */
class Cancelled extends Error {}

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
  /** 008 R19 — the writes of `<integrationsDir>/<id>.json`, one chain per integration (in order). */
  private readonly writes = new Map<string, Promise<unknown>>();
  /** The integrations that have a file: only those are erased at their end. */
  private readonly saved = new Set<string>();

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
    /** « Demander à l'agent »: checked again under its id, still the user's to cancel meanwhile. */
    recheck?: Pending,
  ): Promise<Integration> {
    const id = recheck?.integration.id ?? randomUUID();
    // Read again in the queue: the workspace and the agent may have changed while waiting.
    const { workspace, agent } = this.find(request.agentId);
    const repo = workspace.path;
    let integration: Integration = {
      id,
      agentId: agent.id,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      mode: request.mode,
      message: request.message,
      after: request.after,
      snapshot: snapshot.commit,
      mainAtStart: snapshot.commit,
      state: 'checking',
      conflicts: [],
      error: null,
    };
    let mine = recheck;
    const cancelled = () => mine !== undefined && this.pending.get(id) !== mine;
    const set = (change: Partial<Integration>) => {
      if (cancelled()) throw new Cancelled();
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
          // Announced, then kept in the same step: nothing can ask for it in between.
          const conflicted = set({ state: 'conflicted', conflicts });
          mine = {
            integration: conflicted,
            request,
            workspaceId: workspace.id,
            repo,
            main,
            tip,
            tree: merged.tree,
            sawWorking: false,
            watched: new Map(),
          };
          this.pending.set(id, mine);
          await this.persist(mine);
          return conflicted;
        }
        set({ state: 'committing' });
        // From here main is written: no longer cancellable.
        if (mine) this.pending.delete(id);
        mine = undefined;
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
      if (error instanceof Cancelled) return integration;
      const { failure, state, detail } = failureOf(error);
      set({ state, error: detail });
      await this.erase(id);
      throw failure;
    }
    set({ state: 'integrated' });
    await this.erase(id);
    // main has moved: what follows never turns the integration into a failure.
    await this.afterwards(agent, integration, next).catch(() => undefined);
    return integration;
  }

  /** « Garder main », « Garder cette version », « Les deux » or a content (FR-029). */
  resolve(id: string, resolution: ConflictResolution): Promise<ConflictFile> {
    // Refusals come back as rejections, as from the other requests.
    return Promise.resolve().then(async () => {
      const file = this.applyResolution(id, resolution);
      // The resolution is on the disk when it is told (R19).
      await this.persisted(id);
      return file;
    });
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
    const pending = this.settled(id);
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
    const waiting = this.update(pending, { state: 'waiting-agent', error: null });
    await this.persisted(id);
    return waiting;
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
        // Kept while it is checked again: « Annuler » still works meanwhile.
        for (const stop of pending.watched.values()) stop();
        pending.watched.clear();
        this.update(pending, { state: 'checking' });
        void this.enqueue(pending.workspaceId, async () =>
          this.integrate(pending.request, await this.git.snapshot(worktreePath), pending),
        ).catch(() => undefined);
      }
    }
  }

  /** « Terminer l'intégration »: the resolutions committed, then main moved (FR-030). */
  async finish(id: string): Promise<Integration> {
    const pending = this.settled(id);
    if (!pending.integration.conflicts.every((file) => file.resolved)) {
      throw new IpcFailure('INVALID_INPUT', 'Il reste des conflits à résoudre.');
    }
    return this.enqueue(pending.workspaceId, () => this.complete(pending));
  }

  /** « Annuler l'intégration »: nothing was written to main nor to the worktree (FR-031). */
  async cancel(id: string): Promise<void> {
    const pending = this.get(id);
    this.drop(pending);
    await this.erase(id);
    this.onState({ ...pending.integration, state: 'cancelled' });
    await this.removeCopies(id);
  }

  /**
   * 008 R19, FR-025 — at the start of the app: the integrations stopped on conflicts are taken up again
   * from `<integrationsDir>/<id>.json`, with their resolutions. One whose agent is gone has nothing
   * left to integrate: its file goes. Never throws for a file it cannot read: that file is left alone.
   */
  async restore(): Promise<Integration[]> {
    const dir = this.options.integrationsDir;
    const names = await readdir(dir).catch(() => [] as string[]);
    const restored: Integration[] = [];
    for (const name of names.filter((n) => FILE.test(n)).sort()) {
      const id = name.slice(0, -'.json'.length);
      if (this.pending.has(id)) continue;
      const pending = await this.read(id);
      if (!pending) continue;
      try {
        this.find(pending.integration.agentId);
      } catch {
        await rm(join(dir, name), { force: true });
        continue;
      }
      // What the old process was doing is not kept: the agent's turn and the commit are unknown, the
      // user (or the agent, asked again) goes on from the conflicts; « Terminer » checks main anew.
      pending.integration = {
        ...pending.integration,
        state: 'conflicted',
        error: null,
      };
      this.pending.set(id, pending);
      this.saved.add(id);
      await this.persist(pending);
      this.onState(pending.integration);
      restored.push(pending.integration);
    }
    return restored;
  }

  private async read(id: string): Promise<Pending | null> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.options.integrationsDir, `${id}.json`), 'utf8'),
      ) as Partial<StoredPending> | null;
      const { integration, request, workspaceId, repo, main, tip, tree } = raw ?? {};
      if (
        integration?.id !== id ||
        !Array.isArray(integration.conflicts) ||
        typeof integration.agentId !== 'string' ||
        request === undefined ||
        typeof workspaceId !== 'string' ||
        typeof repo !== 'string' ||
        typeof main !== 'string' ||
        typeof tip !== 'string' ||
        typeof tree !== 'string'
      ) {
        return null;
      }
      return {
        integration,
        request,
        workspaceId,
        repo,
        main,
        tip,
        tree,
        sawWorking: false,
        watched: new Map(),
      };
    } catch {
      return null;
    }
  }

  /** The state of an integration on the disk, after the writes that came before it. */
  private persist(pending: Pending): Promise<void> {
    const { integration, request, workspaceId, repo, main, tip, tree } = pending;
    const stored: StoredPending = { integration, request, workspaceId, repo, main, tip, tree };
    const id = integration.id;
    this.saved.add(id);
    // Best effort: a disk that refuses the write never stops the integration, it only cannot be restored.
    return this.chain(id, async () => {
      const dir = this.options.integrationsDir;
      const target = join(dir, `${id}.json`);
      const temporary = `${target}.tmp`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(temporary, JSON.stringify(stored));
        await rename(temporary, target);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  /** The integration is over (integrated, failed, cancelled): its file goes, and only then. */
  private erase(id: string): Promise<void> {
    if (!this.saved.delete(id)) return Promise.resolve();
    return this.chain(id, () =>
      rm(join(this.options.integrationsDir, `${id}.json`), { force: true }).catch(() => undefined),
    );
  }

  private chain(id: string, task: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(task, task);
    this.writes.set(id, next);
    return next;
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
    await this.erase(integration.id);
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
    void this.persist(pending);
    this.onState(pending.integration);
    return pending.integration;
  }

  private get(id: string): Pending {
    const pending = this.pending.get(id);
    if (!pending) throw new IpcFailure('NOT_FOUND', 'Intégration inconnue ou terminée.');
    return pending;
  }

  /** The writes asked so far are done. */
  private async persisted(id: string): Promise<void> {
    await this.writes.get(id);
  }

  /** Not while it is checked again after the agent: its conflicts are being read anew. */
  private settled(id: string): Pending {
    const pending = this.get(id);
    if (pending.integration.state === 'checking') {
      throw new IpcFailure('INVALID_INPUT', 'L’intégration est en cours de vérification.');
    }
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
