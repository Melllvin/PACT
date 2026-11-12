import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSchema } from '../../../src/shared/model';
import { RESUME_PROMPT } from '../../../src/main/agents/agent-manager';
import { createHarness, git, type Harness } from '../orchestrator/harness';

// 006 US4 — what a persisted `closed` agent must and must not do (FR-023 … FR-026): it is no live
// agent, it is not restarted by itself, and a workspace file saved before the field still loads.

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const KEEP = { removeWorktree: false };

/** An orchestrator and two agents it launched, all awaiting a prompt. */
async function group() {
  const [lead] = await h.launch([h.draft({ orchestrator: true })]);
  const leadId = lead?.id ?? '';
  const launched = await h.manager.launch({
    workspaceId: h.workspace.id,
    agents: [h.draft(), h.draft()],
    counters: { freeTerminal: 0 },
    launchedBy: leadId,
  });
  const [one, two] = launched.map((a) => a.id);
  for (const id of [one ?? '', two ?? '']) await h.waitForState(id, 'awaiting-prompt');
  return { lead: leadId, one: one ?? '', two: two ?? '' };
}

const workspaceNow = () => {
  const workspace = h.workspaces.get(h.workspace.id);
  if (!workspace) throw new Error('no workspace');
  return workspace;
};

const worked = (id: string) => h.pty.history(id).split('Travail en cours').length - 1;

describe('a closed agent at the start of PACT', () => {
  it('stays closed: no process, no « à reprendre », not restarted by itself', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    await h.restart();
    for (const id of Object.values(ids)) {
      expect(h.current(id)?.state).toBe('closed');
      expect(h.current(id)?.lastError).toBeNull();
      expect(h.pty.has(id)).toBe(false);
    }
    expect(h.manager.activeCount()).toBe(0);
  });

  it('keeps what it was doing across the start of PACT, then restarts on request', async () => {
    const ids = await group();
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === ids.one ? { ...a, state: 'working' as const } : a)),
    }));
    await h.manager.close(ids.lead, KEEP);
    await h.restart();
    expect(h.current(ids.one)).toMatchObject({ state: 'closed', closedWhileWorking: true });
    await h.manager.restart(ids.lead, { resumeWork: true });
    await h.waitFor(() => worked(ids.one) === 1, 'no resume prompt', ids.one);
    expect(worked(ids.two)).toBe(0);
  });

  it('reads a workspace file saved before `closedWhileWorking`: nobody is resumed', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      // As the schema reads an older file: the field is missing, it reads false.
      agents: ws.agents.map((a) =>
        agentSchema.parse(
          Object.fromEntries(Object.entries(a).filter(([key]) => key !== 'closedWhileWorking')),
        ),
      ),
    }));
    expect(h.current(ids.one)?.closedWhileWorking).toBe(false);
    await h.manager.restart(ids.lead, { resumeWork: true });
    for (const id of Object.values(ids)) await h.waitForState(id, 'awaiting-prompt');
    await new Promise((r) => setTimeout(r, 300));
    for (const id of Object.values(ids)) expect(worked(id)).toBe(0);
  });
});

describe('a closed agent among the live ones', () => {
  it('does not count in the six agents of a workspace', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    // Three closed hold three places; three more live ones fit: the limit counts live agents.
    const more = await h.manager.launch({
      workspaceId: h.workspace.id,
      agents: [h.draft(), h.draft(), h.draft()],
      counters: { freeTerminal: 0 },
    });
    expect(more).toHaveLength(3);
    expect(workspaceNow().agents).toHaveLength(6);
  });

  it('refuses a launch when closed agents hold every place left', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    const [mine] = await h.manager.launch({
      workspaceId: h.workspace.id,
      agents: [h.draft()],
      counters: { freeTerminal: 0 },
    });
    // Positions: 3 closed + 1 live = 4 taken; 2 left, 3 asked (3 live ≤ 6, but not 3 places).
    await expect(
      h.manager.launch({
        workspaceId: h.workspace.id,
        agents: [h.draft(), h.draft(), h.draft()],
        counters: { freeTerminal: 0 },
      }),
    ).rejects.toMatchObject({
      code: 'LIMIT',
      message: expect.stringContaining('fermés') as string,
    });
    expect(h.current(mine?.id ?? '')).toBeDefined();
  });

  it('creates no « à relire »: its changes are not reviewed', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    h.pending.ids = [ids.one, ids.two];
    expect(await h.review.pendingFiles(h.workspace.id)).toEqual({});
  });
});

describe('closing an orchestrator that launched nobody', () => {
  it('closes as any agent does: the tile goes, the worktree stays', async () => {
    const [lead] = await h.launch([h.draft({ orchestrator: true })]);
    const tree = lead?.worktreePath ?? '';
    await h.manager.close(lead?.id ?? '', KEEP);
    expect(h.current(lead?.id ?? '')).toBeUndefined();
    expect(existsSync(tree)).toBe(true);
  });
});

describe('closing a closed tile, and restarting one agent alone', () => {
  it('forgets the closed tiles of the group, keeping the worktrees', async () => {
    const ids = await group();
    const trees = Object.values(ids).map((id) => h.current(id)?.worktreePath ?? '');
    await h.manager.close(ids.lead, KEEP);
    await h.manager.close(ids.lead, KEEP);
    for (const id of Object.values(ids)) expect(h.current(id)).toBeUndefined();
    for (const tree of trees) expect(existsSync(tree)).toBe(true);
  });

  it('deletes the worktrees of the closed group on « Supprimer »', async () => {
    const ids = await group();
    const branches = Object.values(ids).map((id) => h.current(id)?.branch ?? '');
    const trees = Object.values(ids).map((id) => h.current(id)?.worktreePath ?? '');
    await h.manager.close(ids.lead, KEEP);
    await h.manager.close(ids.lead, { removeWorktree: true });
    for (const id of Object.values(ids)) expect(h.current(id)).toBeUndefined();
    for (const tree of trees) expect(existsSync(tree)).toBe(false);
    for (const branch of branches) expect(git(h.repo, 'branch', '--list', branch)).toBe('');
  });

  it('restarts a closed agent that is not the orchestrator alone', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    await h.manager.restart(ids.one);
    await h.waitForState(ids.one, 'awaiting-prompt');
    expect(h.current(ids.lead)?.state).toBe('closed');
    expect(h.current(ids.two)?.state).toBe('closed');
  });

  it('refuses to restart an agent that is neither in error nor closed', async () => {
    const ids = await group();
    await expect(h.manager.restart(ids.lead)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('types the resume prompt only once the agent is ready, then clears the flag', async () => {
    const ids = await group();
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) => (a.id === ids.one ? { ...a, state: 'working' as const } : a)),
    }));
    await h.manager.close(ids.lead, KEEP);
    await h.manager.restart(ids.one, { resumeWork: true });
    await h.waitFor(() => worked(ids.one) === 1, 'no resume prompt', ids.one);
    expect(h.typed.filter((t) => t.agentId === ids.one).map((t) => t.origin)).toEqual(['resume']);
    expect(h.current(ids.one)?.closedWhileWorking).toBe(false);
    expect(RESUME_PROMPT.length).toBeGreaterThan(0);
  });
});

// 008 R3 — a closed tile stays after the worktree cleanup deleted its folder (006 FR-025 keeps closed
// tiles to be restarted): reopening it says so, rather than failing on a folder that is not there.
describe('a closed tile whose worktree was deleted (008 R3)', () => {
  const remove = (id: string) => {
    const tree = h.current(id)?.worktreePath ?? '';
    git(h.repo, 'worktree', 'remove', '--force', tree);
    return tree;
  };

  it('refuses to restart it, says the worktree was deleted, and starts nothing', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    remove(ids.one);

    const failure = await h.manager.restart(ids.one).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: 'NOT_FOUND' });
    expect((failure as Error).message).toMatch(/worktree .*supprimé/i);
    expect(h.pty.has(ids.one)).toBe(false);
    expect(h.current(ids.one)?.state).toBe('closed');
    expect(h.current(ids.one)?.lastError).toBeNull();
  });

  it('restarts the orchestrator and the members that still have their worktree, and skips the one without', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    remove(ids.one);

    await h.manager.restart(ids.lead);

    await h.waitForState(ids.lead, 'awaiting-prompt');
    await h.waitForState(ids.two, 'awaiting-prompt');
    expect(h.pty.has(ids.one)).toBe(false);
    expect(h.current(ids.one)?.state).toBe('closed');
  });

  it('closes the tile with « Supprimer » even though the folder is gone, and leaves the others’ worktrees deleted', async () => {
    const ids = await group();
    const branchOne = h.current(ids.one)?.branch ?? '';
    const treeTwo = h.current(ids.two)?.worktreePath ?? '';
    await h.manager.close(ids.lead, KEEP);
    remove(ids.one);

    await h.manager.close(ids.lead, { removeWorktree: true });

    for (const id of Object.values(ids)) expect(h.current(id)).toBeUndefined();
    expect(existsSync(treeTwo)).toBe(false);
    expect(git(h.repo, 'branch', '--list', branchOne)).toBe('');
  });
});

// #112 — a closed orchestrator directs nothing: it no longer holds the role of its workspace.
describe('a closed orchestrator and a new one', () => {
  it('launches a new orchestrator while the old one is closed, which becomes an ordinary closed tile', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);

    const [fresh] = await h.launch([h.draft({ orchestrator: true })]);
    const freshId = fresh?.id ?? '';

    expect(h.current(freshId)?.role).toBe('orchestrator');
    expect(h.current(ids.lead)).toMatchObject({ state: 'closed', role: null });
    // Its group stays visible, closed (FR-023), and detached from it.
    expect(h.current(ids.one)).toMatchObject({ state: 'closed', launchedBy: null });
  });

  it('still refuses a second orchestrator while one is live', async () => {
    await h.launch([h.draft({ orchestrator: true })]);
    await expect(h.launch([h.draft({ orchestrator: true })])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('promotes an agent while the orchestrator is closed', async () => {
    const ids = await group();
    await h.manager.close(ids.lead, KEEP);
    const [other] = await h.launch([h.draft()]);
    const otherId = other?.id ?? '';
    await h.waitForState(otherId, 'awaiting-prompt');

    await h.manager.promoteToOrchestrator(otherId);

    expect(h.current(otherId)?.role).toBe('orchestrator');
    expect(h.current(ids.lead)?.role).toBeNull();
  });

  it('detaches the group of the old orchestrator: its closed agents become independent, and stay visible', async () => {
    const ids = await group();
    const [bystander] = await h.launch([h.draft()]);
    await h.manager.close(ids.lead, KEEP);

    await h.launch([h.draft({ orchestrator: true })]);

    // An agent outside the group is left as it is.
    expect(h.current(bystander?.id ?? '')).toMatchObject({ role: null, launchedBy: null });
    for (const id of [ids.lead, ids.one, ids.two]) {
      expect(h.current(id)).toMatchObject({ state: 'closed', launchedBy: null });
    }
    // Restarting one alone no longer brings back the others (no group left).
    await h.manager.restart(ids.one);
    await h.waitForState(ids.one, 'awaiting-prompt');
    expect(h.current(ids.two)?.state).toBe('closed');
    expect(h.current(ids.lead)?.state).toBe('closed');
  });

  it('keeps the old closed orchestrator, its role and its group, when the new launch fails', async () => {
    const ids = await group();
    const [bystander] = await h.launch([h.draft()]);
    await h.manager.close(ids.lead, KEEP);
    vi.spyOn(h.orchestrator, 'prepare').mockRejectedValueOnce(new Error('ENOENT skills'));

    await expect(h.launch([h.draft({ orchestrator: true })])).rejects.toThrow(/ENOENT/);

    expect(h.current(bystander?.id ?? '')).toMatchObject({ role: null });
    expect(h.current(ids.lead)).toMatchObject({ state: 'closed', role: 'orchestrator' });
    expect(h.current(ids.one)).toMatchObject({ launchedBy: ids.lead });
    expect(h.current(ids.two)).toMatchObject({ launchedBy: ids.lead });
    // And the group still restarts with it.
    await h.manager.restart(ids.lead);
    await h.waitForState(ids.one, 'awaiting-prompt');
  });
});
