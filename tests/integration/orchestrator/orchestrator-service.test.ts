import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';
import { callTool, createHarness, gitEnv, type Harness } from './harness';

// 003 T009 — the orchestrator's session: role, token, plugin, one per workspace (R2, R3, R8).

let h: Harness;
let tokens: string[];

beforeEach(async () => {
  h = await createHarness();
  tokens = [];
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const token = register(id, handler);
    tokens.push(token);
    return token;
  });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const ping = (token: string) =>
  fetch(h.hooks.mcpUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pact-token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });

describe('OrchestratorService, the session of an orchestrator', () => {
  it('gives the agent launched as orchestrator its role, its plugin and its own token', async () => {
    const [lead] = await h.launch([h.draft({ orchestrator: true })], 'orchestrate-prompt');
    if (!lead) throw new Error('no lead');
    expect(h.current(lead.id)?.role).toBe('orchestrator');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    const mcp = JSON.parse(
      await readFile(join(h.userData, 'roles', lead.id, 'plugin', '.mcp.json'), 'utf8'),
    ) as { mcpServers: { pact: { url: string } } };
    expect(mcp.mcpServers.pact.url).toBe(h.hooks.mcpUrl());
    expect((await ping(tokens[0] ?? '')).status).toBe(200);
    // The fake orchestrator reaches PACT with the token of its environment.
    h.pty.write(lead.id, 'Codex 2|Bonjour\r');
    await h.waitFor(
      () => h.pty.history(lead.id).includes('MCP send_prompt :'),
      'no MCP call',
      lead.id,
    );
    expect(h.pty.history(lead.id)).not.toContain('HTTP 401');
  });

  it('launches ordinary agents without role nor token', async () => {
    const [agent] = await h.launch([h.draft()]);
    expect(h.current(agent?.id ?? '')?.role).toBeNull();
    expect(tokens).toEqual([]);
  });

  it('refuses a second orchestrator, in the same launch or after', async () => {
    await expect(
      h.manager.launch({
        workspaceId: h.workspace.id,
        agents: [h.draft({ orchestrator: true }), h.draft({ orchestrator: true })],
        counters: { freeTerminal: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await h.launch([h.draft({ orchestrator: true })]);
    await expect(
      h.manager.launch({
        workspaceId: h.workspace.id,
        agents: [h.draft({ orchestrator: true })],
        counters: { freeTerminal: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a CLI that cannot be one', async () => {
    Object.defineProperty(h.adapter, 'supportsOrchestrator', { value: false });
    await expect(
      h.manager.launch({
        workspaceId: h.workspace.id,
        agents: [h.draft({ orchestrator: true })],
        counters: { freeTerminal: 0 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps the role after a restart of PACT, with a new token', async () => {
    const [lead] = await h.launch([h.draft({ orchestrator: true })]);
    const id = lead?.id ?? '';
    await h.restart();
    await h.manager.resume(id);
    await h.waitForState(id, 'awaiting-prompt');
    expect(h.current(id)?.role).toBe('orchestrator');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect((await ping(tokens[0] ?? '')).status).toBe(401);
    expect((await ping(tokens[1] ?? '')).status).toBe(200);
  });

  it('revokes the token once the orchestrator is closed', async () => {
    const [lead] = await h.launch([h.draft({ orchestrator: true })]);
    await h.manager.close(lead?.id ?? '', { removeWorktree: false });
    expect((await ping(tokens[0] ?? '')).status).toBe(401);
    expect((await callTool(h.hooks.mcpUrl(), tokens[0] ?? '', 'list_agents')).status).toBe(401);
  });
});

// 004 US2 — a notice tells the agent's state as it is now, even once it is gone.
describe('OrchestratorService notices', () => {
  it('gives the last state of a closed agent, and « closed » for one never seen', async () => {
    const [lead, worker] = await h.launch([h.draft({ orchestrator: true }), h.draft()]);
    const leadId = lead?.id ?? '';
    const workerId = worker?.id ?? '';
    await h.waitForState(workerId, 'awaiting-prompt');
    await h.manager.close(workerId, { removeWorktree: false });
    await h.orchestrator.wait(leadId, undefined, 50);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    for (const agentId of [workerId, unknown]) {
      h.orchestrator.notice(h.workspace.id, { agentId, kind: 'loop', summary: 'a.ts' });
    }
    const { events } = await h.orchestrator.wait(leadId, [workerId, unknown], 1000);
    // 007: the events come from the journal, where the agent concerned is `about`.
    expect(events.map(({ about, kind, state }) => ({ agentId: about, kind, state }))).toEqual([
      { agentId: workerId, kind: 'loop', state: 'closed' },
      { agentId: unknown, kind: 'loop', state: 'closed' },
    ]);
  });

  it('ignores the state of an agent of no workspace, and a wait with no session', async () => {
    const unknown = '00000000-0000-4000-8000-0000000000fe';
    h.orchestrator.agentState({ agentId: unknown, state: 'done', lastError: null });
    expect(await h.orchestrator.wait(unknown, undefined, 10)).toMatchObject({
      events: [],
      timedOut: false,
      replaced: true,
    });
  });
});

// 007 T006 — what the orchestrator hears goes through the journal of the workspace (research R2):
// written for the orchestrator of the workspace, never about itself save `publish`, typed by
// `typeOf`, and read again when the workspace reloads.
describe('OrchestratorService writes to the journal', () => {
  const event = (agentId: string, kind: 'report' | 'closed' | 'publish', summary = 'Fait') => ({
    at: new Date().toISOString(),
    agentId,
    kind,
    state: 'done' as const,
    summary,
  });

  it('records an event for the orchestrator of the workspace, from PACT, about the agent', async () => {
    const [lead, worker] = await h.launch([h.draft({ orchestrator: true }), h.draft()]);
    h.orchestrator.push(h.workspace.id, event(worker?.id ?? '', 'report', 'Rapport reçu'));
    await h.waitFor(() => h.journal().some((m) => m.kind === 'report'), 'nothing recorded');
    expect(h.journal().find((m) => m.kind === 'report')).toMatchObject({
      from: 'pact',
      to: lead?.id,
      about: worker?.id,
      type: 'action',
      text: 'Rapport reçu',
      unreadBy: [lead?.id],
    });
  });

  it('gives the type of typeOf: a closing is info, a report an action', async () => {
    const [, worker] = await h.launch([h.draft({ orchestrator: true }), h.draft()]);
    h.orchestrator.push(h.workspace.id, event(worker?.id ?? '', 'closed', ''));
    await h.waitFor(() => h.journal().some((m) => m.kind === 'closed'), 'nothing recorded');
    expect(h.journal().find((m) => m.kind === 'closed')?.type).toBe('info');
  });

  it('records nothing about the orchestrator itself, save the answer to its publish request', async () => {
    const [lead] = await h.launch([h.draft({ orchestrator: true })]);
    const id = lead?.id ?? '';
    h.orchestrator.push(h.workspace.id, event(id, 'report', 'sur lui-même'));
    h.orchestrator.push(h.workspace.id, event(id, 'publish', 'issues publiées'));
    await h.waitFor(() => h.journal().length > 0, 'nothing recorded');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.journal().map((m) => m.kind)).toEqual(['publish']);
  });

  it('records nothing in a workspace with no orchestrator', async () => {
    const [worker] = await h.launch([h.draft()]);
    h.orchestrator.push(h.workspace.id, event(worker?.id ?? '', 'report'));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.journal()).toEqual([]);
  });

  it('turns a change of state into an event of the journal (turn-finished is info)', async () => {
    const [, worker] = await h.launch([h.draft({ orchestrator: true }), h.draft()]);
    h.orchestrator.agentState({ agentId: worker?.id ?? '', state: 'done', lastError: null });
    await h.waitFor(() => h.journal().some((m) => m.kind === 'turn-finished'), 'no event');
    expect(h.journal().find((m) => m.kind === 'turn-finished')).toMatchObject({
      type: 'info',
      about: worker?.id,
      state: 'done',
    });
  });

  it('reads the journal again when the workspace reloads its state (FR-004)', async () => {
    const [lead, worker] = await h.launch([h.draft({ orchestrator: true }), h.draft()]);
    h.orchestrator.push(h.workspace.id, event(worker?.id ?? '', 'report', 'À relire'));
    await h.waitFor(() => h.journal().some((m) => m.kind === 'report'), 'nothing recorded');
    // The state file as the app finds it at its next start.
    await h.stores.workspace(h.workspace.id).read();
    const reloaded = new WorkspaceService({
      git: new GitService({ env: gitEnv }),
      stores: h.stores,
    });
    try {
      const again = await reloaded.open(h.repo);
      const kept = reloaded.get(again.id)?.exchanges.messages ?? [];
      expect(kept.map((m) => m.text)).toContain('À relire');
      expect(kept.find((m) => m.text === 'À relire')?.unreadBy).toEqual([lead?.id]);
    } finally {
      reloaded.dispose();
    }
  });
});
