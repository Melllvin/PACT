import type { IpcInput } from '../../shared/ipc';
import type { AgentManager } from '../agents/agent-manager';
import type { IntegrationRequests } from '../orchestrator/integration-requests';
import type { OrchestratorService } from '../orchestrator/orchestrator-service';

// 003 — orchestrator channels (contracts/ipc.md): US3, the integrations it asks for; US5, its
// journal and the withdrawal of its role.

type Dependencies = {
  requests: Pick<IntegrationRequests, 'confirm' | 'refuse'>;
  orchestrator: Pick<OrchestratorService, 'actions'>;
  agents: Pick<AgentManager, 'revokeOrchestrator'>;
};

export function createOrchestratorServices({ requests, orchestrator, agents }: Dependencies) {
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
  };
}
