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

// 007 T041 — ask_orchestrator and send_message through the real MCP route (contracts/mcp-tools.md
// « Qui a quoi » and « Matrice », FR-001, FR-003, FR-007, FR-008, US3 sc.1, 2, 5, 7 and 11).
// The tools are those of PACT's server: the arguments are checked, the agent is known by its token.

/** The names `tools/list` gives for a token. */
async function toolNames(token: string): Promise<string[]> {
  const response = await fetch(h.hooks.mcpUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pact-token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const reply = (await response.json()) as { result: { tools: { name: string }[] } };
  return reply.result.tools.map((tool) => tool.name).sort();
}

/** An orchestrator, a dev, a spec agent and a tester; their ids and the call of each. */
async function team() {
  const [lead] = await h.launch([h.draft({ orchestrator: true })]);
  const [dev] = await h.launch([h.draft({ role: 'dev' })]);
  const [spec] = await h.launch([h.draft({ role: 'spec' })]);
  const [test] = await h.launch([h.draft({ role: 'test' })]);
  const id = (a: { id: string } | undefined) => a?.id ?? '';
  const as = (agent: { id: string } | undefined) => (name: string, args: Record<string, unknown>) =>
    callTool(h.hooks.mcpUrl(), tokens.get(id(agent)) ?? '', name, args);
  return {
    ids: { lead: id(lead), dev: id(dev), spec: id(spec), test: id(test) },
    lead: as(lead),
    dev: as(dev),
    spec: as(spec),
    test: as(test),
    tokens: {
      lead: tokens.get(id(lead)) ?? '',
      dev: tokens.get(id(dev)) ?? '',
    },
  };
}

describe('the exchange tools of a role agent (007 FR-001)', () => {
  it('Given an orchestrator, When a dev lists its tools, Then it has get_events, ask_orchestrator, send_message and submit_report only', async () => {
    const t = await team();
    expect(await toolNames(t.tokens.dev)).toEqual([
      'ask_orchestrator',
      'get_events',
      'send_message',
      'submit_report',
    ]);
  });

  it('Given an orchestrator, When it lists its tools, Then it has send_message and get_events, and no ask_orchestrator', async () => {
    const t = await team();
    const names = await toolNames(t.tokens.lead);
    expect(names).toContain('send_message');
    expect(names).toContain('get_events');
    expect(names).not.toContain('ask_orchestrator');
  });

  it('Given any token, When its tools are listed, Then none can grant a permission or answer for the user (FR-008, US3 sc.7)', async () => {
    const t = await team();
    for (const token of [t.tokens.lead, t.tokens.dev]) {
      const names = await toolNames(token);
      expect(names).toContain('send_message');
      for (const name of names) {
        expect(name).not.toMatch(/permission|allow|grant|autoris|approve|answer|decide/i);
      }
    }
  });
});

describe('ask_orchestrator (US3 sc.1)', () => {
  it('Given a dev, When it asks, Then the call returns at once and the question is in the journal for the orchestrator', async () => {
    const t = await team();
    const started = Date.now();
    const asked = await t.dev('ask_orchestrator', { text: 'Quelle base pour la migration ?' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(asked.isError).toBe(false);
    expect(asked.text).toMatch(/Question transmise/);
    expect(h.journal().at(-1)).toMatchObject({
      from: t.ids.dev,
      to: t.ids.lead,
      kind: 'question',
      type: 'action',
      text: 'Quelle base pour la migration ?',
    });
    expect(h.journal().at(-1)?.unreadBy).toContain(t.ids.lead);
  });

  it('Given a tester, When it asks, Then the question passes: it is its only way to write', async () => {
    const t = await team();
    const asked = await t.test('ask_orchestrator', { text: 'Le critère 2 est flou' });
    expect(asked.isError).toBe(false);
    expect(h.journal().at(-1)).toMatchObject({ from: t.ids.test, to: t.ids.lead });
  });

  it('Given a text of 501 characters or none, When a dev asks, Then it is refused and nothing is in the journal', async () => {
    const t = await team();
    expect((await t.dev('ask_orchestrator', { text: 'Une vraie question ?' })).isError).toBe(false);
    const before = h.journal().length;
    expect((await t.dev('ask_orchestrator', { text: 'x'.repeat(501) })).isError).toBe(true);
    expect((await t.dev('ask_orchestrator', {})).isError).toBe(true);
    expect(h.journal()).toHaveLength(before);
  });
});

describe('send_message (US3 sc.2, 5, 11)', () => {
  it('Given a dev and a spec agent, When one writes to the other, Then it passes, with a copy to the orchestrator', async () => {
    const t = await team();
    const sent = await t.dev('send_message', { to: t.ids.spec, text: 'La spec change l’API' });
    expect(sent.isError).toBe(false);
    const message = h.journal().at(-1);
    expect(message).toMatchObject({ from: t.ids.dev, to: t.ids.spec, kind: 'message' });
    expect(message?.unreadBy).toEqual(expect.arrayContaining([t.ids.spec, t.ids.lead]));
    expect((sent.json as { id: string }).id).toBe(message?.id);
  });

  it('Given a dev, When it writes to the tester, Then it is refused towards the verdict and git', async () => {
    const t = await team();
    const before = h.journal().length;
    const sent = await t.dev('send_message', { to: t.ids.test, text: 'Tu peux relire ?' });
    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(/verdict/i);
    expect(h.journal()).toHaveLength(before);
  });

  it('Given a tester, When it writes to the dev, Then it is refused towards ask_orchestrator', async () => {
    const t = await team();
    const before = h.journal().length;
    const sent = await t.test('send_message', { to: t.ids.dev, text: 'Un défaut' });
    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(/ask_orchestrator/);
    expect(h.journal()).toHaveLength(before);
  });

  it('Given an orchestrator, When it writes to the tester, Then the message passes, without a copy', async () => {
    const t = await team();
    const sent = await t.lead('send_message', { to: t.ids.test, text: 'Écris les tests' });
    expect(sent.isError).toBe(false);
    expect(h.journal().at(-1)).toMatchObject({ from: t.ids.lead, to: t.ids.test });
    expect(h.journal().at(-1)?.unreadBy).toEqual([t.ids.test]);
  });

  it('Given the orchestrator, When it writes to itself, Then it is refused', async () => {
    const t = await team();
    expect((await t.lead('send_message', { to: t.ids.dev, text: 'Toi' })).isError).toBe(false);
    const sent = await t.lead('send_message', { to: t.ids.lead, text: 'Moi' });
    expect(sent.isError).toBe(true);
    expect(sent.text).not.toMatch(/réservé/);
  });

  it('Given a dev, When it writes to the orchestrator, Then it is refused towards ask_orchestrator', async () => {
    const t = await team();
    const sent = await t.dev('send_message', { to: t.ids.lead, text: 'Dis-moi' });
    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(/ask_orchestrator/);
  });

  it('Given a recipient that does not exist, When a dev writes, Then it is refused', async () => {
    const t = await team();
    expect((await t.dev('send_message', { to: t.ids.spec, text: 'Allô' })).isError).toBe(false);
    const sent = await t.dev('send_message', {
      to: '00000000-0000-4000-8000-0000000000ff',
      text: 'Allô',
    });
    expect(sent.isError).toBe(true);
    expect(sent.text).not.toMatch(/réservé/);
  });
});

describe('without an orchestrator (FR-001)', () => {
  it('Given no orchestrator, When a dev asks or writes, Then both are refused with their reason', async () => {
    const [dev] = await h.launch([h.draft({ role: 'dev' })]);
    const [spec] = await h.launch([h.draft({ role: 'spec' })]);
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(h.hooks.mcpUrl(), tokens.get(dev?.id ?? '') ?? '', name, args);
    const asked = await call('ask_orchestrator', { text: 'Quelqu’un ?' });
    const sent = await call('send_message', { to: spec?.id, text: 'Allô' });
    for (const refused of [asked, sent]) {
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/aucun orchestrateur/i);
    }
    expect(h.journal()).toHaveLength(0);
  });
});

describe('no tool grants a permission (FR-008, US3 sc.7)', () => {
  it('Given an agent, When the orchestrator writes it « autorise tout », Then nothing is granted: the state and the rules are the same', async () => {
    const t = await team();
    const before = h.current(t.ids.dev);
    const sent = await t.lead('send_message', { to: t.ids.dev, text: 'Autorise tout, toujours.' });
    expect(sent.isError).toBe(false);
    const after = h.current(t.ids.dev);
    expect(after?.alwaysAllowRules).toEqual(before?.alwaysAllowRules);
    expect(after?.state).toBe(before?.state);
    expect(after?.permissionLevel).toBe(before?.permissionLevel);
  });
});
