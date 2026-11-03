import { describe, expect, it, vi } from 'vitest';
import { createOrchestratorServices } from '../../../../src/main/ipc/orchestrator-handlers';
import { createPreviewServices } from '../../../../src/main/ipc/preview-handlers';
import { IpcFailure } from '../../../../src/shared/ipc';

// 003 T032 — integrationRequest:confirm and integrationRequest:refuse (contracts/ipc.md).

const requestId = '00000000-0000-4000-8000-000000000001';

const setup = () => {
  const integration = { id: requestId, state: 'integrated' };
  const requests = {
    confirm: vi.fn(() => Promise.resolve(integration)),
    refuse: vi.fn(() => Promise.resolve()),
  };
  const orchestrator = { actions: vi.fn(() => []) };
  const agents = { revokeOrchestrator: vi.fn(() => Promise.resolve()) };
  const workspaces = {
    list: () => [{ id: 'w1', agents: [{ id: '00000000-0000-4000-8000-000000000002' }] }],
    update: vi.fn(),
  };
  const loops = {
    decide: vi.fn(() => Promise.resolve()),
    closeAll: vi.fn(() => Promise.resolve()),
  };
  return {
    requests,
    integration,
    orchestrator,
    agents,
    loops,
    services: createOrchestratorServices({
      requests,
      orchestrator,
      agents,
      workspaces,
      loops,
    } as never),
  };
};

describe('integrationRequest channels', () => {
  it('confirms a request with the message the user kept, and gives the integration', async () => {
    const { requests, integration, services } = setup();
    const input = { requestId, message: 'feat: édité', confirmWorking: true };
    await expect(services['integrationRequest:confirm'](input)).resolves.toBe(integration);
    expect(requests.confirm).toHaveBeenCalledWith(input);
  });

  it('refuses a request and gives nothing back', async () => {
    const { requests, services } = setup();
    await expect(services['integrationRequest:refuse']({ requestId })).resolves.toBeUndefined();
    expect(requests.refuse).toHaveBeenCalledWith({ requestId });
  });

  it('passes on why a request cannot be confirmed', async () => {
    const { requests, services } = setup();
    requests.confirm.mockRejectedValueOnce(new IpcFailure('NOT_FOUND', 'Demande introuvable.'));
    await expect(
      services['integrationRequest:confirm']({ requestId, message: 'feat' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// 003 T040 — orchestrator:actions and orchestrator:revoke (contracts/ipc.md).
describe('orchestrator channels', () => {
  const agentId = '00000000-0000-4000-8000-000000000002';

  it('gives the journal of an orchestrator', () => {
    const { orchestrator, services } = setup();
    expect(services['orchestrator:actions']({ agentId })).toEqual([]);
    expect(orchestrator.actions).toHaveBeenCalledWith(agentId);
  });

  it('withdraws the role and closes its loops (004 FR-017)', async () => {
    const { agents, loops, services } = setup();
    await services['orchestrator:revoke']({ agentId });
    expect(agents.revokeOrchestrator).toHaveBeenCalledWith(agentId);
    expect(loops.closeAll).toHaveBeenCalledWith('w1');
  });

  it('closes no loop for an agent in no open workspace', async () => {
    const { loops, services } = setup();
    await services['orchestrator:revoke']({ agentId: '00000000-0000-4000-8000-000000000009' });
    expect(loops.closeAll).not.toHaveBeenCalled();
  });
});

describe('loop:decide (004 T027)', () => {
  it('passes the user’s decision to the loop', async () => {
    const { loops, services } = setup();
    await services['loop:decide']({
      workspaceId: 'w1',
      issueId: '0012-connexion',
      decision: 'abandon',
    });
    expect(loops.decide).toHaveBeenCalledWith('w1', '0012-connexion', 'abandon');
  });

  it('does nothing without loops', async () => {
    const services = createOrchestratorServices({} as never);
    await expect(
      services['loop:decide']({ workspaceId: 'w1', issueId: 'x', decision: 'restart' }),
    ).resolves.toBeUndefined();
  });
});

describe('publishRequest channels (004 T031)', () => {
  it('creates the issues the user confirmed, or publishes nothing once refused', async () => {
    const issues = {
      confirm: vi.fn(() => Promise.resolve({ issues: [{ id: '0012', url: 'u' }] })),
      refuse: vi.fn(() => Promise.resolve()),
    };
    const services = createOrchestratorServices({ issues } as never);
    await expect(services['publishRequest:confirm']({ requestId })).resolves.toEqual({
      issues: [{ id: '0012', url: 'u' }],
    });
    await services['publishRequest:refuse']({ requestId });
    expect(issues.confirm).toHaveBeenCalledWith(requestId);
    expect(issues.refuse).toHaveBeenCalledWith(requestId);
  });

  it('publishes nothing without the issue service', async () => {
    const services = createOrchestratorServices({} as never);
    await expect(services['publishRequest:confirm']({ requestId })).resolves.toEqual({
      issues: [],
    });
    await expect(services['publishRequest:refuse']({ requestId })).resolves.toBeUndefined();
  });
});

describe('roles:setProfiles (004 T016)', () => {
  it('saves the profiles and warns when the test is weaker than the dev', async () => {
    let saved: unknown;
    const workspaces = {
      update: vi.fn((_id: string, change: (ws: object) => object) => {
        saved = change({ id: 'w1' });
        return Promise.resolve(saved);
      }),
    };
    const clis = () => [
      { id: 'claude-code', status: 'installed', modelTiers: [['haiku'], ['sonnet']] },
    ];
    const services = createOrchestratorServices({ workspaces, clis } as never);
    const profile = (model: string) => ({
      cliId: 'claude-code',
      model,
      effort: null,
      maxModel: null,
      escalate: false,
    });
    const profiles = { dev: profile('sonnet'), test: profile('haiku') };
    await expect(services['roles:setProfiles']({ workspaceId: 'w1', profiles })).resolves.toEqual({
      warnings: ['Le profil test (haiku) est plus faible que le profil dev (sonnet).'],
    });
    expect(saved).toEqual({ id: 'w1', roleProfiles: profiles });
  });
});

describe('preview channels (004 T035)', () => {
  it('lists the files of the Aperçu and passes on a decision', async () => {
    const preview = {
      list: vi.fn(() => Promise.resolve([{ path: '.pact/recap.md', kind: 'recap' as const }])),
      decide: vi.fn(),
    };
    const services = createPreviewServices({ preview });
    await expect(services['preview:list']({ agentId: requestId })).resolves.toEqual({
      files: [{ path: '.pact/recap.md', kind: 'recap' }],
    });
    await services['preview:decide']({
      agentId: requestId,
      path: 'design/mockups/a.html',
      decision: 'refused',
    });
    expect(preview.decide).toHaveBeenCalledWith(
      requestId,
      'design/mockups/a.html',
      'refused',
      undefined,
    );
  });
});
