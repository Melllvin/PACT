import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 007 T024, T027, T029 — what the wake asks of AgentManager, and of the journal and the tools around.

let h: Harness;
let token: string;
let lead: string;
let worker: string;

beforeEach(async () => {
  h = await createHarness({ submitDelayMs: 20, submitTimeoutMs: 100 });
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token = register(id, handler);
    return token;
  });
  [lead = ''] = (await h.launch([h.draft({ orchestrator: true })])).map((a) => a.id);
  [worker = ''] = (await h.launch([h.draft()])).map((a) => a.id);
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AgentManager, for the wake', () => {
  it('Given a wake held, When its notice is set then lifted, Then the agent keeps it and loses it', async () => {
    await h.manager.setWakeNotice(worker, 'input');
    expect(h.current(worker)?.wakeNotice).toBe('input');
    await h.manager.setWakeNotice(worker, null);
    expect(h.current(worker)?.wakeNotice ?? null).toBeNull();
  });

  it('Given a line sent in the terminal, When the agent still runs after it, Then the held wake is released', async () => {
    h.manager.typed(worker, 'abc');
    expect(h.manager.promptState(worker)).toBe('busy');
    h.manager.typed(worker, '\r');
    await sleep(250);
    expect(h.manager.promptState(worker)).toBe('empty');
  });

  it('Given a line sent in the terminal, When the agent is closed before the delay ends, Then nothing is flushed and nothing breaks', async () => {
    h.manager.typed(worker, 'abc');
    h.manager.typed(worker, '\r');
    await h.manager.close(worker, { removeWorktree: false });
    await sleep(250);
    expect(h.manager.promptState(worker)).toBe('empty');
  });

  it('Given an events file, When it is written without a hook, Then it is whole and git ignores it', async () => {
    await h.manager.writeEventsFile(worker, 'Un événement\n');
    const file = join(h.current(worker)?.worktreePath ?? '', '.pact', 'events.md');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('Given a hook that fails, When the events file is written, Then nothing is left: no file, no temporary file', async () => {
    const file = join(h.current(worker)?.worktreePath ?? '', '.pact', 'events.md');
    await expect(
      h.manager.writeEventsFile(worker, 'Un événement\n', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('Given an initial prompt already there, When another is remembered, Then the first stays', async () => {
    await h.manager.rememberInitialPrompt(worker, 'Premier');
    await h.manager.rememberInitialPrompt(worker, 'Second');
    expect(h.current(worker)?.initialPrompt).toBe('Premier');
  });
});

describe('ExchangeService, for the wake', () => {
  it('Given an unknown workspace or nothing read, When messages are marked read, Then nothing changes', async () => {
    const heard = h.exchangesHeard.length;
    await h.exchanges?.markRead('unknown', worker, ['x']);
    await h.exchanges?.markRead(h.workspace.id, worker, []);
    expect(h.exchangesHeard).toHaveLength(heard);
    expect(h.exchanges?.unreadOf('unknown', worker)).toEqual([]);
  });

  it('Given an unread message, When it is marked read, Then it is no longer unread for that reader', async () => {
    const message = await h.exchanges?.record(h.workspace.id, {
      from: lead,
      to: worker,
      kind: 'instruction',
      text: 'Fais ceci',
      unreadBy: [worker],
    });
    expect(h.exchanges?.unreadOf(h.workspace.id, worker)).toHaveLength(1);
    await h.exchanges?.markRead(h.workspace.id, worker, [message?.id ?? '']);
    expect(h.exchanges?.unreadOf(h.workspace.id, worker)).toEqual([]);
  });
});

describe('send_prompt behind waiting events', () => {
  it('Given an action waiting for the agent, When an instruction is sent, Then it says how many come first', async () => {
    await h.exchanges?.record(h.workspace.id, {
      from: lead,
      to: worker,
      kind: 'message',
      text: 'D’abord',
    });
    const { json, text } = await callTool(h.hooks.mcpUrl(), token, 'send_prompt', {
      agent: worker,
      text: 'Ensuite',
    });
    expect(text).toContain('derrière 1 événement(s) non lu(s)');
    expect(json).toEqual({ queued: true, position: 1 });
  });

  it('Given an agent closed while its id is still known, When an instruction is sent, Then it is refused', async () => {
    await h.manager.close(worker, { removeWorktree: false });
    const { isError } = await callTool(h.hooks.mcpUrl(), token, 'send_prompt', {
      agent: worker,
      text: 'Trop tard',
    });
    expect(isError).toBe(true);
  });
});
