import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 004 T007 — an agent with a role other than orchestrator gets its own token on /mcp, which opens
// submit_report only, and goes with the agent (research R5).

let h: Harness;
const tokens = new Map<string, string>();

beforeEach(async () => {
  h = await createHarness();
  tokens.clear();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const token = register(id, handler);
    tokens.set(id, token);
    return token;
  });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const report = {
  issue: '0012-connexion',
  status: 'done',
  summary: 'Connexion par e-mail',
  files: ['src/connexion.ts'],
  checks: [{ command: 'npm test', exitCode: 0 }],
};

describe('the token of an agent with a role', () => {
  it('opens submit_report only', async () => {
    const [dev] = await h.launch([h.draft({ role: 'dev' })]);
    const token = tokens.get(dev?.id ?? '') ?? '';
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      callTool(h.hooks.mcpUrl(), token, name, args);

    const accepted = await call('submit_report', report);
    expect(accepted.isError).toBe(false);
    const incomplete = await call('submit_report', { issue: '0012-connexion' });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.text).toContain('status, summary, files, checks');
    for (const name of ['list_agents', 'send_prompt', 'launch_agent']) {
      const refused = await call(name);
      expect(refused.isError).toBe(true);
      expect(refused.text).toBe('Outil réservé à l’orchestrateur.');
    }
  });

  it('is not given to an agent without a role', async () => {
    const [agent] = await h.launch([h.draft()]);
    expect(tokens.has(agent?.id ?? '')).toBe(false);
  });

  it('stops working once the agent is closed', async () => {
    const [test] = await h.launch([h.draft({ role: 'test' })]);
    const token = tokens.get(test?.id ?? '') ?? '';
    await h.manager.close(test?.id ?? '', { removeWorktree: true });
    const { status } = await callTool(h.hooks.mcpUrl(), token, 'submit_report', report);
    expect(status).toBe(401);
  });

  it('reaches the fake agent through its environment', async () => {
    const [recap] = await h.launch([h.draft({ role: 'recap' })]);
    const env = h.launchedEnv(recap?.id ?? '');
    expect(env.PACT_AGENT_MCP_URL).toBe(h.hooks.mcpUrl());
    expect(env.PACT_AGENT_MCP_TOKEN).toBe(tokens.get(recap?.id ?? ''));
    expect(env.PACT_AGENT_TOKEN).not.toBe(env.PACT_AGENT_MCP_TOKEN);
  });
});
