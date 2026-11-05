import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 003 T017 — list_agents and send_prompt (FR-008, FR-009, FR-011, contracts/mcp-tools.md).

let h: Harness;
let token: string;
let lead: string;
let second: string;
let third: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token = register(id, handler);
    return token;
  });
  [lead = ''] = (await h.launch([h.draft({ orchestrator: true })])).map((a) => a.id);
  [second = '', third = ''] = (await h.launch([h.draft(), h.draft()], 'ask-then-echo')).map(
    (a) => a.id,
  );
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

describe('list_agents', () => {
  it('lists the other agents of the workspace, never the orchestrator', async () => {
    h.pending.ids = [third];
    const { isError, json, text } = await tool('list_agents');
    expect(isError).toBe(false);
    expect(text).toContain('Faux CLI 2');
    expect(json).toEqual({
      agents: [
        {
          id: second,
          name: 'Faux CLI 2',
          cli: 'Faux CLI',
          branch: h.current(second)?.branch,
          role: null,
          loop: null,
          state: 'awaiting-prompt',
          question: null,
          toReview: false,
          waitingPrompts: 0,
          // fix-send-prompt: prompts typed but never submitted.
          undeliveredPrompts: 0,
        },
        expect.objectContaining({ id: third, name: 'Faux CLI 3', toReview: true }),
      ],
    });
  });

  it('gives the question an agent waits on', async () => {
    h.pty.write(second, 'Supprime le fichier\r');
    await h.waitForState(second, 'awaiting-answer');
    const { json } = await tool('list_agents');
    expect((json as { agents: { question: string | null }[] }).agents[0]?.question).toBe(
      'rm fichier.txt',
    );
  });
});

// fix-send-prompt — a prompt typed but never submitted is told by list_agents.
describe('list_agents undeliveredPrompts (fix-send-prompt)', () => {
  it('counts the prompts typed but never submitted, once PACT gave up', async () => {
    await h.dispose();
    h = await createHarness({ submitDelayMs: 50, submitTimeoutMs: 200 });
    const register = h.hooks.registerMcp.bind(h.hooks);
    vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
      token = register(id, handler);
      return token;
    });
    [lead = ''] = (await h.launch([h.draft({ orchestrator: true })])).map((a) => a.id);
    [second = ''] = (await h.launch([h.draft()], 'echo-prompt')).map((a) => a.id);
    // The terminal swallows every Enter: the CLI never sees the prompt submitted.
    const write = h.pty.write.bind(h.pty);
    vi.spyOn(h.pty, 'write').mockImplementation((id, data) => {
      if (data !== '\r') write(id, data);
    });
    await tool('send_prompt', { agent: second, text: 'Perdue' });
    const start = Date.now();
    let listed: { agents: { undeliveredPrompts: number; waitingPrompts: number }[] } = {
      agents: [],
    };
    while (Date.now() - start < 5_000) {
      listed = (await tool('list_agents')).json as typeof listed;
      if (listed.agents[0]?.undeliveredPrompts === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(listed.agents[0]).toMatchObject({ undeliveredPrompts: 1, waitingPrompts: 0 });
  });
});

describe('send_prompt', () => {
  it('types the prompt into an agent named in any case, and says it went at once', async () => {
    const { isError, json } = await tool('send_prompt', { agent: 'faux cli 2', text: 'Tâche A' });
    expect(isError).toBe(false);
    expect(json).toEqual({ queued: true, position: 0 });
    await h.waitFor(() => h.pty.history(second).includes('Reçu : Tâche A'), 'not typed', second);
    expect(h.typed).toContainEqual({ agentId: second, origin: 'orchestrator' });
  });

  it('designates an agent by its id too', async () => {
    await tool('send_prompt', { agent: third, text: 'Tâche B' });
    await h.waitFor(() => h.pty.history(third).includes('Reçu : Tâche B'), 'not typed', third);
  });

  it('waits for an agent to answer its question, then types it', async () => {
    h.pty.write(second, 'Supprime le fichier\r');
    await h.waitForState(second, 'awaiting-answer');
    const { json } = await tool('send_prompt', { agent: 'Faux CLI 2', text: 'Ensuite' });
    expect(json).toEqual({ queued: true, position: 1 });
    const listed = (await tool('list_agents')).json as { agents: { waitingPrompts: number }[] };
    expect(listed.agents[0]?.waitingPrompts).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.pty.history(second)).not.toContain('Ensuite');
    await h.manager.answer(second, 'allow');
    await h.waitFor(() => h.pty.history(second).includes('Reçu : Ensuite'), 'not typed', second);
  });

  it('refuses itself, an unknown agent, an agent in error and an empty or too long text', async () => {
    for (const args of [
      { agent: lead, text: 'Moi' },
      { agent: 'Faux CLI 1', text: 'Moi' },
      { agent: 'Codex 9', text: 'Personne' },
      { agent: 'Faux CLI 2', text: '' },
      { agent: 'Faux CLI 2', text: 'x'.repeat(8001) },
    ]) {
      const { isError, text } = await tool('send_prompt', args);
      expect(isError).toBe(true);
      expect(text).not.toBe('');
    }
    await h.manager.close(third, { removeWorktree: false });
    expect((await tool('send_prompt', { agent: third, text: 'x' })).isError).toBe(true);
  });
});

describe('send_prompt to an agent in error', () => {
  it('refuses, saying the user has to resume it', async () => {
    const [dead = ''] = (await h.launch([h.draft()], 'crash-exit-1')).map((a) => a.id);
    h.pty.write(dead, 'Plante\r');
    await h.waitForState(dead, 'error');
    const { isError, text } = await tool('send_prompt', { agent: dead, text: 'Reprends' });
    expect(isError).toBe(true);
    expect(text).toContain('est en erreur : l’utilisateur doit le reprendre.');
    expect(h.typed.some((t) => t.agentId === dead)).toBe(false);
  });
});
