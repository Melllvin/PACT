import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      agents: ws.agents.map(({ closedWhileWorking: _old, ...rest }) => rest),
    }));
    expect(h.current(ids.one)).not.toHaveProperty('closedWhileWorking');
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
