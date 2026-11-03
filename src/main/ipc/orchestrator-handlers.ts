import type { IpcInput } from '../../shared/ipc';
import { z } from 'zod';
import { roleProfileSchema, roleSchema, type CliDefinition } from '../../shared/model';
import { profileWarnings, profilesOf } from '../../shared/roles';
import type { AgentManager } from '../agents/agent-manager';
import type { IntegrationRequests } from '../orchestrator/integration-requests';
import type { LoopService } from '../orchestrator/loop-service';
import type { OrchestratorService } from '../orchestrator/orchestrator-service';
import type { WorkspaceService } from '../workspace/workspace-service';

// 003 — orchestrator channels (contracts/ipc.md): US3, the integrations it asks for; US5, its
// journal and the withdrawal of its role.

type Dependencies = {
  requests: Pick<IntegrationRequests, 'confirm' | 'refuse'>;
  orchestrator: Pick<OrchestratorService, 'actions'>;
  agents: Pick<AgentManager, 'revokeOrchestrator'>;
  /** 004 — the role profiles. */
  workspaces: Pick<WorkspaceService, 'update' | 'list'>;
  clis: () => CliDefinition[];
  /** 004 US2 — the loops: the user's decision, and closed with the orchestrator's role. */
  loops?: Pick<LoopService, 'decide' | 'closeAll'>;
};

export function createOrchestratorServices({
  requests,
  orchestrator,
  agents,
  workspaces,
  clis,
  loops,
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
    'roles:setProfiles': async ({ workspaceId, ...input }: IpcInput<'roles:setProfiles'>) => {
      const profiles = z.partialRecord(roleSchema, roleProfileSchema).parse(input.profiles);
      await workspaces.update(workspaceId, (ws) => ({ ...ws, roleProfiles: profiles }));
      const tiered = clis().map((cli) => ({ ...cli, modelTiers: cli.modelTiers ?? [] }));
      return { warnings: profileWarnings(profilesOf(profiles, tiered), tiered) };
    },
  };
}
