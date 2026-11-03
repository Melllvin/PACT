import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorAction } from '../../../src/shared/orchestrator';
import { callTool, createHarness, type Harness } from './harness';

// 003 T040 — the journal of the orchestrator's actions, and the role withdrawn by the user
// (FR-004, FR-021).

let h: Harness;
let token: string;
let leadId: string;
let workerId: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token = register(id, handler);
    return token;
  });
  const [lead] = await h.launch([h.draft({ orchestrator: true })]);
  // The worker asks the user a permission at its first prompt: what it is sent then waits.
  const [worker] = await h.launch([h.draft()], 'ask-permission');
  leadId = lead?.id ?? '';
  workerId = worker?.id ?? '';
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

describe('the journal of actions', () => {
  it('logs each action, the latest first, with its outcome, but no read nor wait', async () => {
    await tool('list_agents');
    await tool('send_prompt', { agent: 'Faux CLI 2', text: 'Écris la fonction' });
    await tool('send_prompt', { agent: 'Faux CLI 9', text: 'Personne' });
    await tool('wait_for_agents', { timeoutSeconds: 1 });
    await tool('list_agents');

    const actions = h.orchestrator.actions(leadId);
    expect(actions.map((a) => [a.tool, a.outcome])).toEqual([
      ['send_prompt', 'refused'],
      ['send_prompt', 'ok'],
    ]);
    expect(actions[0]).toMatchObject({
      agentId: null,
      reason: expect.stringContaining('Faux CLI 9'),
    });
    expect(actions[1]).toMatchObject({ agentId: workerId, reason: null });
    expect(actions[1]?.summary.length).toBeLessThanOrEqual(200);
    expect(h.actionsHeard.map((a) => a.orchestratorId)).toEqual([leadId, leadId]);
  });

  it('keeps the 200 latest', async () => {
    for (let i = 0; i < 205; i += 1) {
      await tool('send_prompt', { agent: 'Faux CLI 9', text: String(i) });
    }
    const actions: OrchestratorAction[] = h.orchestrator.actions(leadId);
    expect(actions).toHaveLength(200);
  }, 30_000);
});

describe('withdrawing the role', () => {
  it('refuses the token, drops its prompts, ends its wait and leaves an ordinary agent', async () => {
    h.pty.write(workerId, 'Supprime\r');
    await h.waitForState(workerId, 'awaiting-answer');
    await tool('send_prompt', { agent: 'Faux CLI 2', text: 'Plus tard' });
    // Its question already heard: the next wait has nothing to return at once.
    await tool('wait_for_agents', { timeoutSeconds: 1 });
    const waiting = tool('wait_for_agents', { timeoutSeconds: 60 });
    // The wait has reached PACT before the role goes.
    await new Promise((r) => setTimeout(r, 300));

    await h.manager.revokeOrchestrator(leadId);

    expect((await waiting).json).toMatchObject({ events: [] });
    expect(h.manager.waitingPrompts(workerId, 'orchestrator')).toBe(0);
    expect(h.current(leadId)?.role).toBeNull();
    expect((await tool('list_agents')).status).toBe(401);
    const saved = await h.stores.workspace(h.workspace.id).read();
    expect(saved?.agents.find((a) => a.id === leadId)?.role).toBeNull();
  });

  it('is refused for an agent that is not the orchestrator', async () => {
    await expect(h.manager.revokeOrchestrator(workerId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
