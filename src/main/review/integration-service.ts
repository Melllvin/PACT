import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IpcFailure } from '../../shared/ipc';
import { WORKING_STATES, type Agent, type Workspace } from '../../shared/model';
import type { ConflictFile, Integration, IntegrationMode } from '../../shared/review';
import {
  LocalChangesError,
  gitErrorOutput,
  type GitService,
  type MergeResult,
  type Snapshot,
} from '../git/git-service';

// 002 US2 — an agent's changes into main (research R5): the result computed from objects, the
// commit made with the repository's hooks in a temporary worktree, then main moved once.

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
  >;
  workspaces: { list(): Workspace[] };
  agents: { close(id: string, options: { removeWorktree: boolean }): Promise<void> };
  /** `<userData>/integrations`: one temporary worktree per integration, removed after. */
  integrationsDir: string;
  onState?: (integration: Integration) => void;
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

export class IntegrationService {
  private readonly git: Options['git'];
  private readonly onState: NonNullable<Options['onState']>;
  /** One queue per workspace (FR-026). */
  private readonly queues = new Map<string, Promise<unknown>>();

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

  private async integrate(request: IntegrationRequest, snapshot: Snapshot): Promise<Integration> {
    // Read again in the queue: the workspace and the agent may have changed while waiting.
    const { workspace, agent } = this.find(request.agentId);
    const repo = workspace.path;
    let integration: Integration = {
      id: randomUUID(),
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
      this.onState(integration);
      return integration;
    };
    const dir = join(this.options.integrationsDir, integration.id);
    let next: string;
    try {
      let tip: string | undefined;
      for (let attempt = 1; ; attempt++) {
        const main = await this.git.revParse(repo, workspace.mainBranch);
        set({ mainAtStart: main, state: 'checking' });
        tip ??= await this.agentTip(repo, dir, agent, request, snapshot);
        const merged = await this.git.mergeTree(repo, main, tip);
        if (merged.conflicts.length > 0) {
          return set({
            state: 'conflicted',
            conflicts: await this.conflicts(repo, main, tip, merged),
          });
        }
        set({ state: 'committing' });
        next = await this.commit(repo, dir, { main, tip, tree: merged.tree, request });
        try {
          await this.moveMain(repo, workspace.mainBranch, main, next);
          break;
        } catch (error) {
          if (!(error instanceof MainMoved)) throw error;
          if (attempt === ATTEMPTS) {
            set({ state: 'failed', error: 'La branche principale a encore bougé.' });
            throw new IpcFailure(
              'MAIN_MOVED',
              'La branche principale a bougé pendant l’intégration. Réessayer.',
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof IpcFailure) throw error;
      if (error instanceof LocalChangesError) {
        set({ state: 'blocked', error: gitErrorOutput(error) });
        throw new IpcFailure(
          'LOCAL_CHANGES',
          'Des changements locaux sur la branche principale bloquent l’intégration.',
          undefined,
          error.files,
        );
      }
      const output = gitErrorOutput(error);
      set({ state: 'failed', error: output });
      throw new IpcFailure('GIT_FAILED', output);
    }
    set({ state: 'integrated' });
    // main has moved: what follows never turns the integration into a failure.
    await this.afterwards(agent, integration, next).catch(() => undefined);
    return integration;
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
      merged.conflicts.map(async ({ path, kind }) => ({
        path,
        kind,
        mainCommit: (await this.git.lastMainCommit(repo, base, main, path)) ?? {
          short: main.slice(0, 7),
          subject: '',
        },
        hunks: [],
        edited: null,
        resolved: false,
      })),
    );
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
