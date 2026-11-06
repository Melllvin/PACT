import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 007 T014 — the line wait_for_agents writes for an event of the journal, per kind.

let h: Harness;
let token: string;
let worker: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    token = register(id, handler);
    return token;
  });
  await h.launch([h.draft({ orchestrator: true })]);
  const [agent] = await h.launch([h.draft()]);
  worker = agent?.id ?? '';
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const heard = async () =>
  (await callTool(h.hooks.mcpUrl(), token, 'wait_for_agents', { timeoutSeconds: 1 })).text;

describe('wait_for_agents, one line per event', () => {
  it('says a question of a report as a question, with the questions', async () => {
    h.orchestrator.notice(h.workspace.id, {
      agentId: worker,
      kind: 'question',
      summary: 'Bloqué\n1. Quel format ?',
    });
    expect(await heard()).toBe('Faux CLI 2 pose une question : Bloqué\n1. Quel format ?');
  });

  it('says a message of an agent, which is about nobody else', async () => {
    const [lead] = h.workspaces.get(h.workspace.id)?.agents ?? [];
    await h.exchanges?.record(h.workspace.id, {
      from: worker,
      to: lead?.id ?? '',
      kind: 'message',
      text: 'Un mot',
    });
    expect(await heard()).toBe('Faux CLI 2 : Un mot');
  });

  it('names an agent that left the workspace by its identifier', async () => {
    const gone = '00000000-0000-4000-8000-0000000000fe';
    h.orchestrator.notice(h.workspace.id, { agentId: gone, kind: 'loop', summary: 'fini' });
    expect(await heard()).toBe(`${gone} : fini`);
  });

  it('says the error of an agent', async () => {
    h.orchestrator.agentState({
      agentId: worker,
      state: 'error',
      lastError: { code: 1, kind: 'crash', message: 'plantage' },
    });
    expect(await heard()).toBe('Faux CLI 2 est en erreur : plantage');
  });
});
