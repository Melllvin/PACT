import { describe, expect, it, vi } from 'vitest';
import {
  createAgentServices,
  forwardTerminalEvents,
} from '../../../../src/main/ipc/agent-handlers';
import type { AgentDraft } from '../../../../src/shared/ipc';
import type { Agent, CliDefinition } from '../../../../src/shared/model';

// T064 — US2 channels: agents:launch, permission:set, cli:redetect, terminal input and events.
// T074 — US3 tile actions: agent:answer, agent:resume, agent:restart, agent:close, agent:log.

const draft: AgentDraft = {
  cliId: 'fake',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: null,
  branch: null,
  port: null,
  startCommand: null,
};

const custom = { id: 'custom-aider' } as unknown as CliDefinition;

const setup = () => {
  const launched = [{ id: 'a1' }] as unknown as Agent[];
  const deps = {
    registry: {
      detect: vi.fn(() => Promise.resolve([])),
      add: vi.fn(() => Promise.resolve(custom)),
    },
    permissions: { set: vi.fn(() => Promise.resolve()) },
    agents: {
      launch: vi.fn(() => Promise.resolve(launched)),
      answer: vi.fn(() => Promise.resolve()),
      resume: vi.fn(() => Promise.resolve()),
      restart: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      log: vi.fn(() => 'Erreur simulée'),
      cancelAutoResume: vi.fn(() => Promise.resolve()),
      typed: vi.fn(),
    },
    freeTerminals: { open: vi.fn(() => Promise.resolve([])) },
    pty: { write: vi.fn(), resize: vi.fn() },
  };
  return { deps, launched, services: createAgentServices(deps) };
};

describe('createAgentServices', () => {
  it('launches the agents, then the free terminals, and returns the agents', async () => {
    const { deps, launched, services } = setup();
    const counters = { freeTerminal: 1, fake: 1 };
    const result = await services['agents:launch']({
      workspaceId: 'w1',
      agents: [draft],
      freeTerminals: 1,
      counters,
    });
    expect(result).toBe(launched);
    expect(deps.agents.launch).toHaveBeenCalledWith({
      workspaceId: 'w1',
      agents: [draft],
      counters,
    });
    expect(deps.freeTerminals.open).toHaveBeenCalledWith('w1', 1);
  });

  it('opens no free terminal when the agents are refused', async () => {
    const { deps, services } = setup();
    deps.agents.launch.mockRejectedValueOnce(new Error('LIMIT'));
    await expect(
      services['agents:launch']({
        workspaceId: 'w1',
        agents: [draft],
        freeTerminals: 1,
        counters: { freeTerminal: 1 },
      }),
    ).rejects.toThrow('LIMIT');
    expect(deps.freeTerminals.open).not.toHaveBeenCalled();
  });

  it('saves the permission choice and detects the CLIs again on request', async () => {
    const { deps, services } = setup();
    const choice = { level: 'ask-sensitive', autoResume: true, scope: 'global' } as const;
    await services['permission:set'](choice);
    expect(deps.permissions.set).toHaveBeenCalledWith(choice);
    await services['cli:redetect']();
    expect(deps.registry.detect).toHaveBeenCalledOnce();
  });

  it('adds a CLI typed by the user and returns it (cli:add, FR-008)', async () => {
    const { deps, services } = setup();
    expect(await services['cli:add']({ name: 'Aider', command: 'aider' })).toBe(custom);
    expect(deps.registry.add).toHaveBeenCalledWith({ name: 'Aider', command: 'aider' });
  });

  it('passes what the user types and the terminal size to the pseudo-terminal', () => {
    const { deps, services } = setup();
    services['term:write']({ termId: 't1', data: 'Ajoute un test\r' });
    services['term:resize']({ termId: 't1', cols: 120, rows: 40 });
    expect(deps.pty.write).toHaveBeenCalledWith('t1', 'Ajoute un test\r');
    expect(deps.agents.typed).toHaveBeenCalledWith('t1', 'Ajoute un test\r');
    expect(deps.pty.resize).toHaveBeenCalledWith('t1', 120, 40);
  });
});

describe('tile actions (US3)', () => {
  const agentId = '7b0c5d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

  it('answers, resumes and restarts the agent', async () => {
    const { deps, services } = setup();
    await services['agent:answer']({ agentId, answer: 'allow' });
    await services['agent:resume']({ agentId });
    await services['agent:restart']({ agentId });
    expect(deps.agents.answer).toHaveBeenCalledWith(agentId, 'allow', false);
    expect(deps.agents.resume).toHaveBeenCalledWith(agentId);
    expect(deps.agents.restart).toHaveBeenCalledWith(agentId);
  });

  it('cancels the scheduled resume (FR-036)', async () => {
    const { deps, services } = setup();
    await services['agent:cancelAutoResume']({ agentId });
    expect(deps.agents.cancelAutoResume).toHaveBeenCalledWith(agentId);
  });

  it('passes « Toujours pour ce worktree » on to the answer (FR-034)', async () => {
    const { deps, services } = setup();
    await services['agent:answer']({ agentId, answer: 'allow', always: true });
    expect(deps.agents.answer).toHaveBeenCalledWith(agentId, 'allow', true);
  });

  it('closes the agent, keeping or removing its worktree (FR-037)', async () => {
    const { deps, services } = setup();
    await services['agent:close']({ agentId, removeWorktree: true });
    expect(deps.agents.close).toHaveBeenCalledWith(agentId, { removeWorktree: true });
  });

  it('returns the output kept for « Journal »', () => {
    const { services } = setup();
    expect(services['agent:log']({ agentId })).toBe('Erreur simulée');
  });
});

describe('forwardTerminalEvents', () => {
  it('sends terminal output and exits to the renderer', () => {
    let onData: (id: string, data: string) => void = () => undefined;
    let onExit: (id: string, code: number) => void = () => undefined;
    const emit = vi.fn();
    forwardTerminalEvents(
      {
        onData: (listener) => {
          onData = listener;
          return () => undefined;
        },
        onExit: (listener) => {
          onExit = listener;
          return () => undefined;
        },
      },
      emit,
    );
    onData('t1', 'hello');
    onExit('t1', 0);
    expect(emit).toHaveBeenNthCalledWith(1, 'term:data', { termId: 't1', data: 'hello' });
    expect(emit).toHaveBeenNthCalledWith(2, 'term:exit', { termId: 't1', code: 0 });
  });
});
