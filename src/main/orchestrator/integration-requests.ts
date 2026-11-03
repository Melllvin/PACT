import { randomUUID } from 'node:crypto';
import { IpcFailure } from '../../shared/ipc';
import type { Workspace } from '../../shared/model';
import type { IntegrationRequest, OrchestratorEvent } from '../../shared/orchestrator';
import type { Integration, IntegrationMode } from '../../shared/review';
import type { AgentStateEvent } from '../agents/agent-manager';
import type { GitService } from '../git/git-service';
import type { IntegrationService } from '../review/integration-service';

// 003 US3 — the integrations an orchestrator asks for: kept in the workspace until the user
// confirms or refuses them, their outcome told back to the orchestrator (FR-017…FR-020, R6).

type Options = {
  workspaces: {
    list(): Workspace[];
    update(id: string, change: (workspace: Workspace) => Workspace): Promise<Workspace>;
  };
  integration: Pick<IntegrationService, 'start'>;
  git: Pick<GitService, 'revParse'>;
  /** The orchestrators of the workspace hear of the outcome. */
  notify: (workspaceId: string, event: OrchestratorEvent) => void;
  /** The À faire column follows the list (`workspace:integrationRequests`). */
  onChange?: (workspaceId: string, requests: IntegrationRequest[]) => void;
};

type Outcome = NonNullable<OrchestratorEvent['integration']>['outcome'];

/** An integration started from a request, followed until it ends. */
type Followed = { workspaceId: string; requestId: string; started: boolean };

const ENDED: Integration['state'][] = ['integrated', 'failed', 'blocked', 'cancelled'];

export class IntegrationRequests {
  /** By agent: one integration of an agent at a time (002 FR-026). */
  private readonly followed = new Map<string, Followed>();

  constructor(private readonly options: Options) {}

  /** A new request for an agent replaces its previous one (FR-020); main is left as it is. */
  async request(
    workspaceId: string,
    { agentId, message, mode }: { agentId: string; message: string; mode: IntegrationMode },
  ): Promise<IntegrationRequest> {
    const request: IntegrationRequest = {
      id: randomUUID(),
      agentId,
      mode,
      message,
      requestedAt: new Date().toISOString(),
    };
    await this.change(workspaceId, (requests) => [
      ...requests.filter((r) => r.agentId !== agentId),
      request,
    ]);
    return request;
  }

  /** Integrates as « Intégrer » would, then closes the tile and keeps the worktree (R6). */
  async confirm({
    requestId,
    message,
    confirmWorking,
  }: {
    requestId: string;
    message: string;
    confirmWorking?: boolean | undefined;
  }): Promise<Integration> {
    const { workspaceId, request } = this.find(requestId);
    const followed: Followed = { workspaceId, requestId, started: false };
    this.followed.set(request.agentId, followed);
    try {
      return await this.options.integration.start({
        agentId: request.agentId,
        mode: request.mode,
        message,
        after: { closeTile: true, removeWorktree: false },
        confirmWorking,
      });
    } catch (error) {
      // Refused before it started (the agent works, it is gone…): the request stays.
      if (!followed.started && this.followed.get(request.agentId) === followed) {
        this.followed.delete(request.agentId);
      }
      throw error;
    }
  }

  async refuse({ requestId }: { requestId: string }): Promise<void> {
    const { workspaceId, request } = this.find(requestId);
    await this.drop(workspaceId, requestId);
    this.tell(workspaceId, request.agentId, 'refused', 'Intégration refusée par l’utilisateur.');
  }

  /** Each state of an integration (`integration:state`): those from a request are told back. */
  integrationState(integration: Integration): void {
    const followed = this.followed.get(integration.agentId);
    if (!followed) return;
    const { workspaceId } = followed;
    if (!followed.started) {
      followed.started = true;
      void this.drop(workspaceId, followed.requestId);
    }
    if (ENDED.includes(integration.state)) this.followed.delete(integration.agentId);
    const { agentId, state, conflicts, error } = integration;
    if (state === 'integrated') void this.integrated(workspaceId, agentId);
    else if (state === 'conflicted') {
      const files = conflicts.map((c) => c.path);
      this.tell(workspaceId, agentId, 'conflicted', `Conflits : ${files.join(', ')}`, { files });
    } else if (state === 'failed' || state === 'blocked') {
      this.tell(workspaceId, agentId, 'failed', error ?? 'L’intégration a échoué.');
    } else if (state === 'cancelled') {
      this.tell(workspaceId, agentId, 'refused', 'Intégration annulée par l’utilisateur.');
    }
  }

  /** A closed agent takes its request with it (data-model IntegrationRequest). */
  agentState({ agentId, state }: AgentStateEvent): void {
    if (state !== 'closed') return;
    for (const workspace of this.options.workspaces.list()) {
      const request = workspace.integrationRequests.find((r) => r.agentId === agentId);
      if (request) void this.drop(workspace.id, request.id);
    }
  }

  private async integrated(workspaceId: string, agentId: string) {
    const workspace = this.options.workspaces.list().find((ws) => ws.id === workspaceId);
    const commit = workspace
      ? await this.options.git.revParse(workspace.path, workspace.mainBranch).catch(() => undefined)
      : undefined;
    const summary = commit ? `Commit ${commit.slice(0, 7)} sur la branche principale.` : '';
    this.tell(workspaceId, agentId, 'integrated', summary, commit ? { commit } : {});
  }

  private tell(
    workspaceId: string,
    agentId: string,
    outcome: Outcome,
    summary: string,
    extra: { commit?: string; files?: string[] } = {},
  ) {
    const agent = this.options.workspaces
      .list()
      .find((ws) => ws.id === workspaceId)
      ?.agents.find((a) => a.id === agentId);
    this.options.notify(workspaceId, {
      at: new Date().toISOString(),
      agentId,
      kind: 'integration',
      state: agent?.state ?? 'closed',
      summary,
      integration: { outcome, ...extra },
    });
  }

  private find(requestId: string) {
    for (const workspace of this.options.workspaces.list()) {
      const request = workspace.integrationRequests.find((r) => r.id === requestId);
      if (request) return { workspaceId: workspace.id, request };
    }
    throw new IpcFailure('NOT_FOUND', 'Demande d’intégration introuvable.');
  }

  private drop(workspaceId: string, requestId: string) {
    return this.change(workspaceId, (requests) => requests.filter((r) => r.id !== requestId));
  }

  private async change(
    workspaceId: string,
    next: (requests: IntegrationRequest[]) => IntegrationRequest[],
  ) {
    const saved = await this.options.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      integrationRequests: next(ws.integrationRequests),
    }));
    this.options.onChange?.(workspaceId, saved.integrationRequests);
  }
}
