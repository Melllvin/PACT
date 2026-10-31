import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

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
      await readFile(join(h.userData, 'orchestrator', lead.id, 'plugin', '.mcp.json'), 'utf8'),
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
