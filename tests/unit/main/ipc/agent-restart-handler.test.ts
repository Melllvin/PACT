import { describe, expect, it, vi } from 'vitest';
import { createAgentServices } from '../../../../src/main/ipc/agent-handlers';

// 006 FR-026 — `agent:restart` carries « Reprendre le travail » to the agent manager.

const agentId = '7b0c5d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

const setup = () => {
  const restart = vi.fn(() => Promise.resolve());
  const services = createAgentServices({
    registry: { detect: vi.fn(), add: vi.fn() },
    permissions: { set: vi.fn() },
    agents: {
      launch: vi.fn(),
      answer: vi.fn(),
      resume: vi.fn(),
      restart,
      close: vi.fn(),
      log: vi.fn(),
      cancelAutoResume: vi.fn(),
      typed: vi.fn(),
    },
    freeTerminals: { open: vi.fn() },
    pty: { write: vi.fn(), resize: vi.fn() },
  });
  return { restart, services };
};

describe('agent:restart', () => {
  it.each([true, false])('passes resumeWork %s on', async (resumeWork) => {
    const { restart, services } = setup();
    await services['agent:restart']({ agentId, resumeWork });
    expect(restart).toHaveBeenCalledWith(agentId, { resumeWork });
  });
});
