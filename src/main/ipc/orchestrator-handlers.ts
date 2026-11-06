import type { IpcInput } from '../../shared/ipc';
import { z } from 'zod';
import { roleProfileSchema, roleSchema, type CliDefinition } from '../../shared/model';
import { profileWarnings, profilesOf } from '../../shared/roles';
import type { AgentManager } from '../agents/agent-manager';
import type { ExchangeService } from '../orchestrator/exchange-service';
import type { IntegrationRequests } from '../orchestrator/integration-requests';
import type { IssueService } from '../orchestrator/issues';
import type { LoopService } from '../orchestrator/loop-service';
import type { OrchestratorService } from '../orchestrator/orchestrator-service';
import type { WorkspaceService } from '../workspace/workspace-service';

// 003 — orchestrator channels (contracts/ipc.md): US3, the integrations it asks for; US5, its
// journal and the withdrawal of its role.

type Dependencies = {
  requests: Pick<IntegrationRequests, 'confirm' | 'refuse'>;
  orchestrator: Pick<OrchestratorService, 'actions'>;
  /** 007 — the journal; absent in the suites that do not use it. */
  exchanges?: Pick<ExchangeService, 'decide'>;
  agents: Pick<AgentManager, 'revokeOrchestrator'>;
  /** 004 — the role profiles. */
  workspaces: Pick<WorkspaceService, 'update' | 'list'>;
  clis: () => CliDefinition[];
  /** 004 US2 — the loops: the user's decision, and closed with the orchestrator's role. */
  loops?: Pick<LoopService, 'decide' | 'closeAll'>;
  /** 004 US3 — the publication of issues the orchestrator asked for. */
  issues?: Pick<IssueService, 'confirm' | 'refuse'>;
};

export function createOrchestratorServices({
  requests,
  orchestrator,
  exchanges,
  agents,
  workspaces,
  clis,
  loops,
  issues,
}: Dependencies) {
  return {
    'integrationRequest:confirm': (input: IpcInput<'integrationRequest:confirm'>) =>
      requests.confirm(input),
    'integrationRequest:refuse': async (input: IpcInput<'integrationRequest:refuse'>) => {
      await requests.refuse(input);
    },
    'orchestrator:actions': ({ agentId }: IpcInput<'orchestrator:actions'>) =>
      orchestrator.actions(agentId),
    'orchestrator:revoke': async ({ agentId }: IpcInput<'orchestrator:revoke'>) => {
      const workspace = workspaces.list().find((ws) => ws.agents.some((a) => a.id === agentId));
      await agents.revokeOrchestrator(agentId);
      // 004 — its loops close; the agents they had stay open.
      if (workspace) await loops?.closeAll(workspace.id);
    },
    'loop:decide': async ({ workspaceId, issueId, decision }: IpcInput<'loop:decide'>) => {
      if (!loops) return;
      await loops.decide(workspaceId, issueId, decision);
    },
    'exchange:decide': async ({
      workspaceId,
      escalationId,
      decision,
    }: IpcInput<'exchange:decide'>) => {
      await exchanges?.decide(workspaceId, escalationId, decision);
    },
    'publishRequest:confirm': async ({ requestId }: IpcInput<'publishRequest:confirm'>) => {
      if (!issues) return { issues: [] };
      return issues.confirm(requestId);
    },
    'publishRequest:refuse': async ({ requestId }: IpcInput<'publishRequest:refuse'>) => {
      await issues?.refuse(requestId);
    },
    'roles:setProfiles': async ({ workspaceId, ...input }: IpcInput<'roles:setProfiles'>) => {
      const profiles = z.partialRecord(roleSchema, roleProfileSchema).parse(input.profiles);
      await workspaces.update(workspaceId, (ws) => ({ ...ws, roleProfiles: profiles }));
      const installed = clis();
      return { warnings: profileWarnings(profilesOf(profiles, installed), installed) };
    },
  };
}
