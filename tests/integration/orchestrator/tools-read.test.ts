import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, createHarness, type Harness } from './harness';

// 003 T026 — get_changes, get_file_diff, run_tests and wait_for_agents (FR-012…FR-014, SC-002).

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
  const [agent] = await h.launch([h.draft()], 'edit-echo');
  worker = agent?.id ?? '';
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

/** The agent writes src/données à jour.ts during its turn (scenario edit-echo). */
const turn = async () => {
  h.pty.write(worker, 'Écris\r');
  await h.waitForState(worker, 'done');
};

describe('get_changes and get_file_diff', () => {
  it('give what the review shows: files, totals, tests and conflicts', async () => {
    await turn();
    const { isError, json } = await tool('get_changes', { agent: 'Faux CLI 2' });
    expect(isError).toBe(false);
    const changes = json as {
      branch: string;
      files: { path: string; added: number }[];
      added: number;
      removed: number;
      tests: unknown;
      conflicts: unknown;
    };
    expect(changes.branch).toBe(h.current(worker)?.branch);
    expect(changes.files.map((f) => f.path)).toEqual(['src/données à jour.ts']);
    expect(changes.added).toBe(3);
    expect(changes.tests).toBeNull();
    expect(changes.conflicts).toBe('none');
  });

  it('gives the diff of one file as unified text', async () => {
    await turn();
    const { json } = await tool('get_file_diff', {
      agent: 'Faux CLI 2',
      path: 'src/données à jour.ts',
    });
    expect(json).toMatchObject({ path: 'src/données à jour.ts' });
    expect((json as { unified: string }).unified).toContain('+deux de l’agent');
  });

  it('refuses a path outside the repository or not changed', async () => {
    await turn();
    for (const path of ['../etc/passwd', '/etc/passwd', 'README.md']) {
      expect((await tool('get_file_diff', { agent: 'Faux CLI 2', path })).isError).toBe(true);
    }
  });
});

describe('get_file_diff, a binary file', () => {
  it('gives its size, without a line diff', async () => {
    await writeFile(join(h.current(worker)?.worktreePath ?? '', 'logo.bin'), 'logo\0binaire');
    const { json } = await tool('get_file_diff', { agent: 'Faux CLI 2', path: 'logo.bin' });
    expect(json).toEqual({ path: 'logo.bin', binary: true, size: 12 });
  });
});

describe('run_tests', () => {
  it('refuses without a test command, then runs the workspace one', async () => {
    expect((await tool('run_tests', { agent: 'Faux CLI 2' })).isError).toBe(true);
    await h.workspaces.update(h.workspace.id, (ws) => ({ ...ws, testCommand: 'node --version' }));
    const { isError, json } = await tool('run_tests', { agent: 'Faux CLI 2' });
    expect(isError).toBe(false);
    expect(json).toEqual({ status: 'running' });
    await h.waitFor(() => h.tests.latest(worker)?.status === 'passed', 'tests not passed');
    expect(
      ((await tool('get_changes', { agent: 'Faux CLI 2' })).json as { tests: unknown }).tests,
    ).toMatchObject({ status: 'passed', command: 'node --version' });
  });
});

describe('wait_for_agents', () => {
  it('is woken under 2 s after an agent ends its turn (SC-002)', async () => {
    const waiting = tool('wait_for_agents', { agents: ['Faux CLI 2'], timeoutSeconds: 30 });
    await new Promise((r) => setTimeout(r, 100));
    h.pty.write(worker, 'Écris\r');
    const started = Date.now();
    await h.waitForState(worker, 'done');
    const { isError, json } = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      timedOut: false,
      events: [{ about: worker, kind: 'turn-finished', state: 'done' }],
    });
  });

  it('ends with no change once the delay is over', async () => {
    expect((await tool('wait_for_agents', { timeoutSeconds: 1 })).json).toEqual({
      events: [],
      remaining: 0,
      timedOut: true,
    });
  });

  // 007 FR-019: a wait is 60 s at most, no more 240 s.
  it('refuses a delay out of 1 to 60 seconds', async () => {
    expect((await tool('wait_for_agents', { timeoutSeconds: 61 })).isError).toBe(true);
    expect((await tool('wait_for_agents', { timeoutSeconds: 240 })).isError).toBe(true);
    expect((await tool('wait_for_agents', { timeoutSeconds: 0 })).isError).toBe(true);
  });

  it('keeps an event that came while it was not waiting', async () => {
    await turn();
    expect((await tool('wait_for_agents', { timeoutSeconds: 1 })).json).toMatchObject({
      events: [{ about: worker, kind: 'turn-finished' }],
    });
  });

  it('tells the user’s decision on a mockup (004 FR-028)', async () => {
    h.orchestrator.notice(h.workspace.id, {
      agentId: worker,
      kind: 'mockup',
      summary: 'maquette design/mockups/a.html validée par l’utilisateur.',
    });
    expect((await tool('wait_for_agents', { timeoutSeconds: 1 })).text).toBe(
      'Faux CLI 2 : maquette design/mockups/a.html validée par l’utilisateur.',
    );
  });

  it('tells a question and a closing too', async () => {
    const [asker = ''] = (await h.launch([h.draft()], 'ask-permission')).map((a) => a.id);
    h.pty.write(asker, 'Supprime\r');
    await h.waitForState(asker, 'awaiting-answer');
    expect(
      (await tool('wait_for_agents', { agents: ['Faux CLI 3'], timeoutSeconds: 5 })).text,
    ).toBe('Faux CLI 3 attend une réponse de l’utilisateur.');
    await h.manager.close(asker, { removeWorktree: false });
    expect((await tool('wait_for_agents', { timeoutSeconds: 5 })).json).toMatchObject({
      events: [{ about: asker, kind: 'closed' }],
    });
  });
});

// 007 T007 — get_events and the bounded, shared reading of wait_for_agents (FR-009, FR-019, SC-008).
type Event = {
  id: string;
  at: string;
  from: string;
  about?: string;
  type: string;
  kind: string;
  state?: string;
  summary: string;
};
type Events = { events: Event[]; remaining: number; note: string };

/** `count` reports of the worker for the orchestrator, `size` characters each. */
const notices = (count: number, size = 100, kind: 'loop' | 'report' = 'report') => {
  for (let n = 1; n <= count; n++) {
    h.orchestrator.notice(h.workspace.id, {
      agentId: worker,
      kind,
      summary: `${String(n).padStart(3, '0')} ${'x'.repeat(size - 4)}`,
    });
  }
};

describe('get_events (contracts/mcp-tools.md)', () => {
  it('gives the unread events in the contract’s format, with a note on reported data', async () => {
    notices(2);
    const { isError, json } = await tool('get_events');
    expect(isError).toBe(false);
    const { events, remaining, note } = json as Events;
    expect(events).toHaveLength(2);
    expect(remaining).toBe(0);
    expect(events[0]).toMatchObject({
      from: 'pact',
      about: worker,
      type: 'action',
      kind: 'report',
      state: 'done',
    });
    expect(typeof events[0]?.id).toBe('string');
    expect(typeof events[0]?.at).toBe('string');
    expect(events[0]?.summary).toContain('001');
    expect(note).toMatch(/donn[ée]es rapport[ée]es/);
    expect(note).toMatch(/consignes? de l’utilisateur/);
  });

  it('gives an event once: the second call has nothing', async () => {
    notices(1);
    expect(((await tool('get_events')).json as Events).events).toHaveLength(1);
    expect(((await tool('get_events')).json as Events).events).toEqual([]);
  });

  it('gives the 20 most recent unread, then the rest, and says how many remain (FR-009)', async () => {
    notices(25);
    const first = (await tool('get_events')).json as Events;
    expect(first.events).toHaveLength(20);
    expect(first.remaining).toBe(5);
    const second = (await tool('get_events')).json as Events;
    expect(second.events).toHaveLength(5);
    expect(second.remaining).toBe(0);
    const ids = [...first.events, ...second.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(25);
  });

  it('gives a summary of 200 characters, and the whole text with get_events({ id })', async () => {
    h.orchestrator.notice(h.workspace.id, {
      agentId: worker,
      kind: 'report',
      summary: `début ${'y'.repeat(1500)} fin`,
    });
    const [event] = ((await tool('get_events')).json as Events).events;
    expect(event?.summary.length).toBeLessThanOrEqual(200);
    const detail = await tool('get_events', { id: event?.id });
    expect(detail.isError).toBe(false);
    const { event: whole } = detail.json as { event: Event & { text: string } };
    expect(whole.id).toBe(event?.id);
    expect(whole.text).toBe(`début ${'y'.repeat(1500)} fin`);
  });

  it('does not change the reading when it gives a detail, and can give it again', async () => {
    notices(1);
    const id = h.journal()[0]?.id ?? '';
    expect((await tool('get_events', { id })).isError).toBe(false);
    expect((await tool('get_events', { id })).isError).toBe(false);
    expect(((await tool('get_events')).json as Events).events).toHaveLength(1);
  });

  it('refuses an unknown event', async () => {
    expect((await tool('get_events', { id: '00000000-0000-4000-8000-0000000000aa' })).isError).toBe(
      true,
    );
  });
});

describe('wait_for_agents, bounded and shared with get_events (US5 sc.1 to 3, SC-008)', () => {
  it('gives at most 20 events of 200 characters, and what remains, whatever the length of the outputs', async () => {
    // Before 007, 100 events of 7 700 characters came back in one answer: 770 000 characters.
    notices(100, 7700, 'loop');
    const { isError, text, json } = await tool('wait_for_agents', { timeoutSeconds: 1 });
    expect(isError).toBe(false);
    const { events, remaining } = json as Events;
    expect(events).toHaveLength(20);
    expect(remaining).toBe(80);
    for (const event of events) expect(event.summary.length).toBeLessThanOrEqual(200);
    expect(text.length).toBeLessThan(6000);
    expect(JSON.stringify(json).length).toBeLessThan(12_000);
  });

  it('shares its reading with get_events: what one gave, the other does not', async () => {
    notices(25);
    const read = (await tool('get_events')).json as Events;
    expect(read.events).toHaveLength(20);
    const waited = (await tool('wait_for_agents', { timeoutSeconds: 1 })).json as Events;
    expect(waited.events).toHaveLength(5);
    expect(waited.remaining).toBe(0);
    expect(waited.events.map((e) => e.id)).not.toEqual(
      expect.arrayContaining([read.events[0]?.id]),
    );
    expect(((await tool('get_events')).json as Events).events).toEqual([]);
  });

  it('gives an event once, to get_events or to a wait', async () => {
    notices(1);
    expect(
      ((await tool('wait_for_agents', { timeoutSeconds: 1 })).json as Events).events,
    ).toHaveLength(1);
    expect(((await tool('get_events')).json as Events).events).toEqual([]);
  });
});

describe('list_agents gives the questions of a report (research R8)', () => {
  it('gives every question in full, the journal keeping 2000 characters only', async () => {
    const questions = ['Quel format pour la date ?', `Peux-tu trancher ? ${'z'.repeat(3000)}`];
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      agents: ws.agents.map((a) =>
        a.id === worker ? { ...a, lastReport: { status: 'blocked' as const, questions } } : a,
      ),
    }));
    const { json } = await tool('list_agents');
    const agents = (json as { agents: { id: string; questions?: string[] }[] }).agents;
    expect(agents.find((a) => a.id === worker)?.questions).toEqual(questions);
  });

  it('gives an empty list for an agent with no report', async () => {
    const agents = ((await tool('list_agents')).json as { agents: { questions?: string[] }[] })
      .agents;
    expect(agents[0]?.questions).toEqual([]);
  });
});
