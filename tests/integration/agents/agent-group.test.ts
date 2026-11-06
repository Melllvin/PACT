import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agentsView from '../../../src/shared/agents-view';
import type { Agent, Workspace } from '../../../src/shared/model';
import { createHarness, git, type Harness } from '../orchestrator/harness';

// 006 US4 (T033) — an orchestrator and the agents it launched are closed and restarted together
// (FR-023 … FR-026). The CLI is the fake one: « Travail en cours » is printed once per prompt typed.

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

// The code under test is not written yet: its names are read at run time, so these tests fail on
// the missing behavior, not on a type error.
type GroupApi = { agentsLaunchedBy: (workspace: Workspace, orchestratorId: string) => Agent[] };
const agentsLaunchedBy = (workspace: Workspace, orchestratorId: string): Agent[] =>
  (agentsView as unknown as Partial<GroupApi>).agentsLaunchedBy?.(workspace, orchestratorId) ??
  (() => {
    throw new Error('agentsLaunchedBy is not exported by src/shared/agents-view.ts');
  })();

const restart = (id: string, resumeWork: boolean) => h.manager.restart(id, { resumeWork });

const KEEP = { removeWorktree: false };

/** An orchestrator, two agents it launched (`worker` was working when closed), one the user launched. */
async function group() {
  const [lead] = await h.launch([h.draft({ orchestrator: true })]);
  const leadId = lead?.id ?? '';
  const launched = await h.manager.launch({
    workspaceId: h.workspace.id,
    agents: [h.draft(), h.draft()],
    counters: { freeTerminal: 0 },
    launchedBy: leadId,
  });
  const [worker, idle] = launched;
  const [mine] = await h.manager.launch({
    workspaceId: h.workspace.id,
    agents: [h.draft()],
    counters: { freeTerminal: 0 },
  });
  const ids = {
    lead: leadId,
    worker: worker?.id ?? '',
    idle: idle?.id ?? '',
    mine: mine?.id ?? '',
  };
  for (const id of [ids.worker, ids.idle, ids.mine]) await h.waitForState(id, 'awaiting-prompt');
  return ids;
}

/** The agent works at the time it is closed (the state is what PACT reads, not the CLI). */
const makeWork = (id: string) =>
  h.workspaces.update(h.workspace.id, (ws) => ({
    ...ws,
    agents: ws.agents.map((a) => (a.id === id ? { ...a, state: 'working' as const } : a)),
  }));

const worked = (id: string) => h.pty.history(id).split('Travail en cours').length - 1;
const onDisk = async (id: string) =>
  (await h.stores.workspace(h.workspace.id).read())?.agents.find((a) => a.id === id);
const stateOf = (id: string) => h.current(id)?.state ?? 'closed';

describe('agentsLaunchedBy', () => {
  it('lists the agents launched by that orchestrator, by position', async () => {
    const ids = await group();
    const workspace = h.workspaces.get(h.workspace.id);
    if (!workspace) throw new Error('no workspace');
    expect(agentsLaunchedBy(workspace, ids.lead).map((a) => a.id)).toEqual([ids.worker, ids.idle]);
  });

  it('leaves out the orchestrator, the agents of the user and an unknown orchestrator', async () => {
    const ids = await group();
    const workspace = h.workspaces.get(h.workspace.id);
    if (!workspace) throw new Error('no workspace');
    const listed = agentsLaunchedBy(workspace, ids.lead).map((a) => a.id);
    expect(listed).not.toContain(ids.lead);
    expect(listed).not.toContain(ids.mine);
    expect(agentsLaunchedBy(workspace, ids.mine)).toEqual([]);
    expect(agentsLaunchedBy(workspace, '00000000-0000-4000-8000-0000000000ff')).toEqual([]);
  });
});

describe('closing the orchestrator (FR-023)', () => {
  it('closes the orchestrator and its agents, keeping every worktree, and no other agent', async () => {
    const ids = await group();
    const trees = [ids.lead, ids.worker, ids.idle].map((id) => h.current(id)?.worktreePath ?? '');
    await h.manager.close(ids.lead, KEEP);
    for (const id of [ids.lead, ids.worker, ids.idle]) {
      expect(h.current(id)?.state).toBe('closed');
      expect(h.pty.has(id)).toBe(false);
    }
    for (const tree of trees) expect(existsSync(tree)).toBe(true);
    // The agent the user launched stays open (spec, scenario 2).
    expect(h.current(ids.mine)?.state).toBe('awaiting-prompt');
    expect(h.pty.has(ids.mine)).toBe(true);
  });

  it('applies the worktree choice to all of them: « supprimer » removes the three', async () => {
    const ids = await group();
    const trees = [ids.lead, ids.worker, ids.idle].map((id) => h.current(id)?.worktreePath ?? '');
    const branches = [ids.lead, ids.worker, ids.idle].map((id) => h.current(id)?.branch ?? '');
    await h.manager.close(ids.lead, { removeWorktree: true });
    for (const id of [ids.lead, ids.worker, ids.idle]) expect(h.current(id)).toBeUndefined();
    for (const tree of trees) expect(existsSync(tree)).toBe(false);
    for (const branch of branches) expect(git(h.repo, 'branch', '--list', branch)).toBe('');
    expect(h.current(ids.mine)?.state).toBe('awaiting-prompt');
  });
});

describe('closing an agent that is not the orchestrator (FR-024)', () => {
  it('closes only that agent', async () => {
    const ids = await group();
    await h.manager.close(ids.worker, KEEP);
    expect(stateOf(ids.worker)).toBe('closed');
    expect(h.pty.has(ids.worker)).toBe(false);
    for (const id of [ids.lead, ids.idle, ids.mine]) {
      expect(h.current(id)?.state).toBe('awaiting-prompt');
      expect(h.pty.has(id)).toBe(true);
    }
  });
});

describe('what the group was doing when it was closed (closedWhileWorking)', () => {
  it('is remembered for each agent, and saved', async () => {
    const ids = await group();
    await makeWork(ids.worker);
    await h.manager.close(ids.lead, KEEP);
    expect(h.current(ids.worker)).toMatchObject({ state: 'closed', closedWhileWorking: true });
    expect(h.current(ids.idle)).toMatchObject({ state: 'closed', closedWhileWorking: false });
    expect(h.current(ids.lead)).toMatchObject({ state: 'closed', closedWhileWorking: false });
    expect(await onDisk(ids.worker)).toMatchObject({ closedWhileWorking: true });
    expect(await onDisk(ids.idle)).toMatchObject({ closedWhileWorking: false });
  });
});

describe('restarting the closed orchestrator (FR-025, FR-026)', () => {
  it('restarts the three on their worktrees, with their role and their link', async () => {
    const ids = await group();
    const before = [ids.lead, ids.worker, ids.idle].map((id) => h.current(id));
    await makeWork(ids.worker);
    await h.manager.close(ids.lead, KEEP);
    await restart(ids.lead, false);
    for (const id of [ids.lead, ids.worker, ids.idle]) await h.waitForState(id, 'awaiting-prompt');
    const after = [ids.lead, ids.worker, ids.idle].map((id) => h.current(id));
    expect(after.map((a) => a && [a.worktreePath, a.role, a.launchedBy, a.branch])).toEqual(
      before.map((a) => a && [a.worktreePath, a.role, a.launchedBy, a.branch]),
    );
    expect(h.current(ids.mine)?.state).toBe('awaiting-prompt');
  });

  it('with « Reprendre le travail », gives the resume prompt to the agent that worked only', async () => {
    const ids = await group();
    await makeWork(ids.worker);
    await h.manager.close(ids.lead, KEEP);
    await restart(ids.lead, true);
    for (const id of [ids.lead, ids.worker, ids.idle]) await h.waitForState(id, 'awaiting-prompt');
    await h.waitFor(() => worked(ids.worker) === 1, 'no resume prompt for the worker', ids.worker);
    await new Promise((r) => setTimeout(r, 400));
    expect(worked(ids.worker)).toBe(1);
    expect(worked(ids.idle)).toBe(0);
    expect(worked(ids.lead)).toBe(0);
  });

  it('without « Reprendre le travail », gives no prompt to anyone', async () => {
    const ids = await group();
    await makeWork(ids.worker);
    await h.manager.close(ids.lead, KEEP);
    await restart(ids.lead, false);
    for (const id of [ids.lead, ids.worker, ids.idle]) await h.waitForState(id, 'awaiting-prompt');
    await new Promise((r) => setTimeout(r, 400));
    for (const id of [ids.lead, ids.worker, ids.idle]) expect(worked(id)).toBe(0);
  });
});
