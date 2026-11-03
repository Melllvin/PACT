import type { IpcInput } from '../../shared/ipc';
import { z } from 'zod';
import { roleProfileSchema, roleSchema, type CliDefinition } from '../../shared/model';
import { profileWarnings, profilesOf } from '../../shared/roles';
import type { AgentManager } from '../agents/agent-manager';
import type { IntegrationRequests } from '../orchestrator/integration-requests';
import type { OrchestratorService } from '../orchestrator/orchestrator-service';
import type { WorkspaceService } from '../workspace/workspace-service';

// 003 — orchestrator channels (contracts/ipc.md): US3, the integrations it asks for; US5, its
// journal and the withdrawal of its role.

type Dependencies = {
  requests: Pick<IntegrationRequests, 'confirm' | 'refuse'>;
  orchestrator: Pick<OrchestratorService, 'actions'>;
  agents: Pick<AgentManager, 'revokeOrchestrator'>;
  /** 004 — the role profiles. */
  workspaces: Pick<WorkspaceService, 'update'>;
  clis: () => CliDefinition[];
};

export function createOrchestratorServices({
  requests,
  orchestrator,
  agents,
  workspaces,
  clis,
}: Dependencies) {
  return {
    'integrationRequest:confirm': (input: IpcInput<'integrationRequest:confirm'>) =>
      requests.confirm(input),
    'integrationRequest:refuse': async (input: IpcInput<'integrationRequest:refuse'>) => {
      await requests.refuse(input);
    },
    'orchestrator:actions': ({ agentId }: IpcInput<'orchestrator:actions'>) =>
      orchestrator.actions(agentId),
    'orchestrator:revoke': ({ agentId }: IpcInput<'orchestrator:revoke'>) =>
      agents.revokeOrchestrator(agentId),
    'roles:setProfiles': async ({ workspaceId, ...input }: IpcInput<'roles:setProfiles'>) => {
      const profiles = z.partialRecord(roleSchema, roleProfileSchema).parse(input.profiles);
      await workspaces.update(workspaceId, (ws) => ({ ...ws, roleProfiles: profiles }));
      const installed = clis();
      return { warnings: profileWarnings(profilesOf(profiles, installed), installed) };
    },
  };
}
