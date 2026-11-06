import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, git, type Harness } from './harness';

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
          // 007 R8: the questions of a blocked report.
          questions: [],
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

// 007 T020 — an instruction goes through the journal, never through the prompt (FR-015, FR-024,
// SC-004, R11). The harness must wire the wake as the app does, so that a pointer reaches the agent.
const INSTRUCTION = 'Ligne un\nLigne deux\n\n  Ligne quatre avec <balise> et `code`';

const instructions = () => h.journal().filter((m) => m.kind === 'instruction');
const quiet = () => new Promise((r) => setTimeout(r, 600));

describe('send_prompt records an instruction (007 R11, FR-015, FR-024)', () => {
  it('Given a multi-line text, When the orchestrator sends it, Then one action instruction is recorded, whole and identical', async () => {
    const { isError, json } = await tool('send_prompt', { agent: 'Faux CLI 2', text: INSTRUCTION });
    expect(isError).toBe(false);
    // The answer keeps its format.
    expect(json).toMatchObject({ queued: true });
    expect(typeof (json as { position: unknown }).position).toBe('number');
    const [message, ...others] = instructions();
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      from: lead,
      to: second,
      type: 'action',
      kind: 'instruction',
      text: INSTRUCTION,
      unreadBy: [second],
    });
  });

  it('Given that instruction, When the agent reads it by id, Then the text is given back identical, without any wrapping', async () => {
    await tool('send_prompt', { agent: 'Faux CLI 2', text: INSTRUCTION });
    const id = instructions()[0]?.id ?? '';
    const { isError, json } = await tool('get_events', { id });
    expect(isError).toBe(false);
    const { event } = json as { event: { id: string; kind: string; text: string } };
    expect(event).toMatchObject({ id, kind: 'instruction' });
    expect(event.text).toBe(INSTRUCTION);
    expect(event.text).not.toMatch(/pasted_content|\x1b\[200~/);
  });

  it('Given an instruction, When PACT wakes the agent, Then none of its text reaches the terminal of the agent as a prompt', async () => {
    await tool('send_prompt', { agent: 'Faux CLI 2', text: INSTRUCTION });
    await quiet();
    expect(h.typed.filter((t) => t.origin === 'orchestrator')).toEqual([]);
    const history = h.pty.history(second);
    // The fake CLI replays what it reads by `get_events` or in the file, which is its own business:
    // what PACT typed is a pointer, and the pointer holds no word of the text.
    expect(history).not.toContain('Ligne un\nLigne deux');
    expect(history).not.toContain('\x1b[200~');
  });

  it('Given an instruction asked at once for two agents, When both are read, Then each one has its own message', async () => {
    await tool('send_prompt', { agent: 'Faux CLI 2', text: 'Pour deux' });
    await tool('send_prompt', { agent: 'Faux CLI 3', text: 'Pour trois' });
    expect(instructions().map((m) => [m.to, m.text])).toEqual([
      [second, 'Pour deux'],
      [third, 'Pour trois'],
    ]);
  });

  it('Given a text over 8000 characters, When it is sent, Then it is refused and nothing is recorded', async () => {
    const { isError } = await tool('send_prompt', { agent: 'Faux CLI 2', text: 'x'.repeat(8001) });
    expect(isError).toBe(true);
    expect(instructions()).toEqual([]);
  });

  it('Given an agent in error, When a prompt is sent, Then it is refused and nothing is recorded', async () => {
    const [dead = ''] = (await h.launch([h.draft()], 'crash-exit-1')).map((a) => a.id);
    h.pty.write(dead, 'Plante\r');
    await h.waitForState(dead, 'error');
    const { isError } = await tool('send_prompt', { agent: dead, text: 'Reprends' });
    expect(isError).toBe(true);
    expect(instructions()).toEqual([]);
  });
});

describe('launch_agent with a prompt records an instruction (007 R11)', () => {
  it('Given a multi-line prompt, When the agent is launched, Then its first message is an instruction, whole', async () => {
    const { isError, json } = await tool('launch_agent', {
      cli: 'Faux CLI',
      branch: 'feat/consigne',
      prompt: INSTRUCTION,
    });
    expect(isError).toBe(false);
    const launched = (json as { agent: { id: string } }).agent.id;
    const [message, ...others] = instructions();
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      from: lead,
      to: launched,
      kind: 'instruction',
      text: INSTRUCTION,
    });
    await quiet();
    expect(h.typed.filter((t) => t.origin === 'orchestrator')).toEqual([]);
    expect(h.pty.history(launched)).not.toContain('Ligne un\nLigne deux');
  });
});

describe('an agent without MCP reads .pact/events.md (007 R11)', () => {
  const eventsFile = (id: string) => join(h.current(id)?.worktreePath ?? '', '.pact', 'events.md');

  it('Given an agent without role, When an instruction is sent, Then .pact/events.md holds the whole text and git ignores it', async () => {
    expect(h.current(second)?.role).toBeNull();
    await tool('send_prompt', { agent: 'Faux CLI 2', text: INSTRUCTION });
    // The wake groups for 5 s: the file is written with the pointer.
    await h.waitFor(() => existsSync(eventsFile(second)), 'no .pact/events.md', second, 20_000);
    const content = await readFile(eventsFile(second), 'utf8');
    expect(content).toContain(INSTRUCTION);
    const worktree = h.current(second)?.worktreePath ?? '';
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'events.md',
    );
    expect(git(worktree, 'check-ignore', '.pact/events.md')).toContain('events.md');
  });

  it('Given an agent without role, When the file is written, Then the unread are counted as read: get_events has nothing new for it', async () => {
    await tool('send_prompt', { agent: 'Faux CLI 2', text: INSTRUCTION });
    await h.waitFor(() => existsSync(eventsFile(second)), 'no .pact/events.md', second, 20_000);
    expect(instructions()[0]?.unreadBy).toEqual([]);
  });

  it('Given an agent of a role, When an instruction is sent, Then it has MCP and no .pact/events.md is written for it', async () => {
    const [dev = ''] = (await h.launch([h.draft({ role: 'dev' })], 'echo-prompt')).map((a) => a.id);
    await tool('send_prompt', { agent: dev, text: INSTRUCTION });
    await h.waitFor(() => h.pty.history(dev).includes('Reçu'), 'never woken', dev, 20_000);
    expect(existsSync(eventsFile(dev))).toBe(false);
  });
});
