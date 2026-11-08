import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';

// 006 US5 / #45 — the paths of `promoteToOrchestrator` and `renameAgent` the acceptance tests leave
// out: no orchestrator service, a permission already chosen, a restart that never ends, a rename
// to the same name, an agent whose CLI is no longer known.

let h: Harness;
let first: string;
let second: string;

beforeEach(async () => {
  h = await createHarness();
  const [a, b] = await h.launch([h.draft(), h.draft()]);
  first = a?.id ?? '';
  second = b?.id ?? '';
  await h.waitFor(() => h.current(first)?.sessionId != null, 'no session id', first);
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

describe('promoteToOrchestrator, other paths', () => {
  it('is refused when PACT has no orchestrator service', async () => {
    (h.manager as unknown as { orchestrator: undefined }).orchestrator = undefined;
    await expect(h.manager.promoteToOrchestrator(first)).rejects.toThrow(/indisponible/);
    expect(h.current(first)?.role).toBeNull();
  });

  it('keeps the permission the project already chose', async () => {
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      permissionOverride: { level: 'always-ask', autoResume: false, scope: 'project' },
    }));
    const stub = h.workspaces as unknown as { hasPermissionChoice?: () => Promise<boolean> };
    stub.hasPermissionChoice = () => Promise.resolve(true);
    await h.manager.promoteToOrchestrator(first);
    const kept = h.workspaces.get(h.workspace.id)?.permissionOverride;
    expect(kept?.level).toBe('always-ask');
  });

  it('treats a workspace that cannot tell as one with a choice', async () => {
    const stub = h.workspaces as unknown as { hasPermissionChoice?: unknown };
    stub.hasPermissionChoice = undefined;
    await h.manager.promoteToOrchestrator(first);
    expect(h.current(first)?.role).toBe('orchestrator');
    expect(h.workspaces.get(h.workspace.id)?.permissionOverride).toBeNull();
  });

  it('stops waiting for a restart that does not end', async () => {
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === first ? { ...a, state: 'starting' as const } : a)),
    }));
    const wait = (
      h.manager as unknown as { untilStarted: (id: string, ms: number) => Promise<void> }
    ).untilStarted;
    await expect(wait.call(h.manager, first, -1)).resolves.toBeUndefined();
  });
});

describe('renameAgent, other paths', () => {
  it('accepts the name the agent already has, without a change', async () => {
    await h.manager.renameAgent(first, 'Alice');
    await expect(h.manager.renameAgent(first, ' Alice ')).resolves.toBeUndefined();
    expect((h.current(first) as { name?: string | null } | undefined)?.name).toBe('Alice');
  });

  it('names an agent after its CLI id when the CLI is no longer known', async () => {
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === second ? { ...a, cliId: 'ghost' } : a)),
    }));
    await expect(h.manager.renameAgent(first, 'ghost 2')).rejects.toThrow(/déjà pris/);
  });
});
