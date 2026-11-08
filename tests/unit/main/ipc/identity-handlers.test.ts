import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorServices } from '../../../../src/main/ipc/orchestrator-handlers';
import { IpcFailure } from '../../../../src/shared/ipc';

// 006 phase 7b — orchestrator:promote and agent:rename reach the agent manager (#45, #46).

const agentId = '00000000-0000-4000-8000-000000000002';

const setup = () => {
  const identity = {
    promoteToOrchestrator: vi.fn(() => Promise.resolve()),
    renameAgent: vi.fn(() => Promise.resolve()),
  };
  const services = createOrchestratorServices({
    requests: {},
    orchestrator: { actions: vi.fn(() => []) },
    agents: { revokeOrchestrator: vi.fn() },
    workspaces: { list: () => [], update: vi.fn() },
    identity,
  } as never);
  return { identity, services };
};

describe('identity channels', () => {
  it('promotes the agent through the manager', async () => {
    const { identity, services } = setup();
    await expect(services['orchestrator:promote']({ agentId })).resolves.toBeUndefined();
    expect(identity.promoteToOrchestrator).toHaveBeenCalledWith(agentId);
  });

  it('renames the agent through the manager', async () => {
    const { identity, services } = setup();
    await expect(services['agent:rename']({ agentId, name: 'Alice' })).resolves.toBeUndefined();
    expect(identity.renameAgent).toHaveBeenCalledWith(agentId, 'Alice');
  });

  it('passes on the reason of a refusal', async () => {
    const { identity, services } = setup();
    identity.promoteToOrchestrator.mockRejectedValueOnce(new IpcFailure('INVALID_INPUT', 'Non.'));
    await expect(services['orchestrator:promote']({ agentId })).rejects.toThrow('Non.');
  });

  it('does nothing without a manager', async () => {
    const services = createOrchestratorServices({
      requests: {},
      orchestrator: { actions: vi.fn() },
      agents: {},
      workspaces: { list: () => [], update: vi.fn() },
    } as never);
    await expect(services['agent:rename']({ agentId, name: 'x' })).resolves.toBeUndefined();
  });
});
