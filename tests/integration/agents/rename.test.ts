import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from '../orchestrator/harness';

// 006 T045 (#45) — `AgentManager.renameAgent(agentId, name)`: refuses an empty or taken name with
// its reason, persists the name, and the MCP tools of 007 resolve the new name.
// Assumed API: `renameAgent(agentId, name): Promise<void>` rejecting with an Error whose message is
// the reason; the name is kept as `agent.name` (null: « <CLI> <position> »).

let h: Harness;
let token: string;
let lead: string;
let worker: string;

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const issued = register(id, handler);
    token ||= issued;
    return issued;
  });
  token = '';
  const [a] = await h.launch([h.draft({ orchestrator: true })]);
  const [b] = await h.launch([h.draft()]);
  lead = a?.id ?? '';
  worker = b?.id ?? '';
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);
const nameOf = (id: string) => (h.current(id) as { name?: string | null } | undefined)?.name;

describe('renameAgent', () => {
  it.each(['', '   '])(
    'Given the name « %s », When renamed, Then it is refused with a reason',
    async (empty) => {
      await expect(h.manager.renameAgent(worker, empty)).rejects.toThrow(/nom/i);
      expect(nameOf(worker) ?? null).toBeNull();
    },
  );

  it('Given a name used by another agent, When renamed, Then it is refused, case ignored', async () => {
    await h.manager.renameAgent(worker, 'Relecteur');
    await expect(h.manager.renameAgent(lead, 'relecteur')).rejects.toThrow(/déjà/);
    expect(nameOf(lead) ?? null).toBeNull();
  });

  it('Given the default name of another agent, When renamed to it, Then it is refused', async () => {
    await expect(h.manager.renameAgent(worker, 'Faux CLI 1')).rejects.toThrow(/déjà/);
  });

  it('Given a valid name with spaces around, When renamed, Then it is saved trimmed', async () => {
    await h.manager.renameAgent(worker, '  Relecteur  ');
    expect(nameOf(worker)).toBe('Relecteur');
  });

  it('Given a renamed agent, When PACT restarts, Then the name is still there', async () => {
    await h.manager.renameAgent(worker, 'Relecteur');
    await h.restart();
    expect(nameOf(worker)).toBe('Relecteur');
  });
});

describe('the new name in the MCP tools (007)', () => {
  it('Given a renamed agent, When the orchestrator calls send_prompt with the new name, Then the instruction reaches it; the old name no longer resolves', async () => {
    await h.manager.renameAgent(worker, 'Relecteur');

    const sent = await tool('send_prompt', { agent: 'Relecteur', text: 'Relis le diff' });
    const old = await tool('send_prompt', { agent: 'Faux CLI 2', text: 'Encore' });

    expect(sent.isError).toBe(false);
    expect(old.isError).toBe(true);
    expect(old.text).toContain('Faux CLI 2');
    const instruction = h.journal().find((m) => m.type === 'action' && m.to === worker);
    expect(instruction?.text).toContain('Relis le diff');
  });

  it('Given a renamed agent, When the orchestrator calls wait_for_agents with the new name, Then it is understood and the events speak of it by that name', async () => {
    await h.manager.renameAgent(worker, 'Relecteur');
    const ok = await tool('wait_for_agents', { agents: ['Relecteur'], timeoutSeconds: 1 });
    expect(ok.isError).toBe(false);

    await h.exchanges?.record(h.workspace.id, {
      from: worker,
      to: lead,
      kind: 'message',
      text: 'Un mot',
    });
    const heard = await tool('wait_for_agents', { timeoutSeconds: 1 });
    expect(heard.text).toBe('Relecteur : Un mot');
  });

  it('Given a message from a renamed agent, When the orchestrator reads get_events, Then the event is about that agent and its whole text is readable by id', async () => {
    await h.manager.renameAgent(worker, 'Relecteur');
    const recorded = await h.exchanges?.record(h.workspace.id, {
      from: worker,
      to: lead,
      kind: 'message',
      text: 'Un mot du relecteur',
    });

    const { json } = await tool('get_events');
    const events = (json as { events: { id: string; from: string }[] }).events;
    expect(events.map((e) => e.from)).toEqual([worker]);
    const whole = await tool('get_events', { id: events[0]?.id ?? recorded?.id ?? '' });
    expect(whole.text).toBe('Un mot du relecteur');
  });
});
