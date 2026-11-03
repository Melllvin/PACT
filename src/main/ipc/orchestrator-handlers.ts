import type { IpcInput } from '../../shared/ipc';
import type { IntegrationRequests } from '../orchestrator/integration-requests';

// 003 — orchestrator channels (contracts/ipc.md). T035: US3, the integrations it asks for.

type Dependencies = {
  requests: Pick<IntegrationRequests, 'confirm' | 'refuse'>;
};

export function createOrchestratorServices({ requests }: Dependencies) {
  return {
    'integrationRequest:confirm': (input: IpcInput<'integrationRequest:confirm'>) =>
      requests.confirm(input),
    'integrationRequest:refuse': async (input: IpcInput<'integrationRequest:refuse'>) => {
      await requests.refuse(input);
    },
  };
}
