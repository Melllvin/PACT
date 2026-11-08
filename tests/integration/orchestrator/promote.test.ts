import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 006 T038 (US5, FR-027, FR-028) — « Faire orchestrateur »: `AgentManager.promoteToOrchestrator(agentId)`
// refuses with its reason, or gives the role, prepares the orchestrator access as at launch and
// restarts the agent in its own session.
// Assumed API: `promoteToOrchestrator(agentId): Promise<void>`, rejecting with an Error (IpcFailure)
// whose message is the reason shown to the user.

let h: Harness;
let first: string;
let second: string;

beforeEach(async () => {
  h = await createHarness();
  const [a, b] = await h.launch([h.draft(), h.draft()]);
  first = a?.id ?? '';
  second = b?.id ?? '';
  // The session the CLI announced: the promotion must resume exactly this one.
  await h.waitFor(() => h.current(first)?.sessionId != null, 'no session id', first);
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

describe('promoteToOrchestrator', () => {
  it('Given an agent without role and no orchestrator, When promoted, Then it has the role and restarts in its session (FR-028)', async () => {
    const sessionBefore = h.current(first)?.sessionId;
    expect(h.launchedEnv(first)).not.toHaveProperty('PACT_ORCHESTRATOR_TOKEN');

    await h.manager.promoteToOrchestrator(first);

    expect(h.current(first)?.role).toBe('orchestrator');
    await h.waitForState(first, 'awaiting-prompt');
    expect(h.pty.history(first)).toContain(`Session reprise ${String(sessionBefore)}`);
    expect(h.current(first)?.sessionId).toBe(sessionBefore);
    // The other agent is left alone.
    expect(h.current(second)?.role).toBeNull();
    expect(h.pty.history(second)).not.toContain('Session reprise');
  });

  it('Given an agent of another role, When promoted, Then it becomes the orchestrator too (US5 scenario 1)', async () => {
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === first ? { ...a, role: 'dev' as const } : a)),
    }));

    await h.manager.promoteToOrchestrator(first);

    expect(h.current(first)?.role).toBe('orchestrator');
  });

  it('Given the promotion, When the agent restarts, Then it has the orchestrator access as at launch (plugin and token)', async () => {
    await h.manager.promoteToOrchestrator(first);
    await h.waitForState(first, 'awaiting-prompt');

    const env = h.launchedEnv(first);
    expect(env.PACT_ORCHESTRATOR_URL).toBe(h.hooks.mcpUrl());
    expect(env.PACT_ORCHESTRATOR_TOKEN).toBeTruthy();
  });

  it('Given a workspace with an orchestrator, When another agent is promoted, Then it is refused with the reason and nothing changes (scenario 2)', async () => {
    await h.manager.promoteToOrchestrator(first);
    await h.waitForState(first, 'awaiting-prompt');
    const historyBefore = h.pty.history(second);

    await expect(h.manager.promoteToOrchestrator(second)).rejects.toThrow(
      /Faux CLI 1 est déjà l.orchestrateur/,
    );

    expect(h.current(second)?.role).toBeNull();
    expect(h.current(first)?.role).toBe('orchestrator');
    expect(h.pty.history(second)).toBe(historyBefore);
  });

  it('Given a CLI that cannot be orchestrator, When its agent is promoted, Then it is refused with the reason and not restarted (scenario 3)', async () => {
    Object.defineProperty(h.adapter, 'supportsOrchestrator', { value: false });
    const historyBefore = h.pty.history(first);

    await expect(h.manager.promoteToOrchestrator(first)).rejects.toThrow(/orchestrateur/);

    expect(h.current(first)?.role).toBeNull();
    expect(h.pty.history(first)).toBe(historyBefore);
  });

  it('Given an unknown agent, When promoted, Then it is refused', async () => {
    await expect(
      h.manager.promoteToOrchestrator('00000000-0000-4000-8000-0000000000fe'),
    ).rejects.toThrow();
  });

  it('Given the new orchestrator, When it launches an agent with its token, Then the agent is linked to it (scenario 4, FR-011)', async () => {
    await h.manager.promoteToOrchestrator(first);
    await h.waitForState(first, 'awaiting-prompt');
    const env = h.launchedEnv(first);

    const { isError, json } = await callTool(
      env.PACT_ORCHESTRATOR_URL ?? '',
      env.PACT_ORCHESTRATOR_TOKEN ?? '',
      'launch_agent',
      { cli: 'Faux CLI' },
    );

    expect(isError).toBe(false);
    const { agent } = json as { agent: { id: string } };
    expect(h.current(agent.id)?.launchedBy).toBe(first);
  });

  it('Given an agent at work, When promoted, Then it restarts all the same: the tile keeps its place and its session', async () => {
    const [busy] = await h.launch([h.draft()], 'ask-permission');
    const id = busy?.id ?? '';
    await h.waitFor(() => h.current(id)?.sessionId != null, 'no session id', id);
    h.pty.write(id, 'Supprime\r');
    await h.waitForState(id, 'awaiting-answer');
    const sessionBefore = h.current(id)?.sessionId;

    await h.manager.promoteToOrchestrator(id);

    expect(h.current(id)?.role).toBe('orchestrator');
    await h.waitFor(() => h.current(id)?.state !== 'awaiting-answer', 'never restarted', id);
    expect(h.current(id)?.sessionId).toBe(sessionBefore);
    expect(h.pty.history(id)).toContain(`Session reprise ${String(sessionBefore)}`);
  });
});
