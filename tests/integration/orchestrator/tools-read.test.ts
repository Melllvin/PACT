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
      events: [{ agentId: worker, kind: 'turn-finished', state: 'done' }],
    });
  });

  it('ends with no change once the delay is over', async () => {
    expect((await tool('wait_for_agents', { timeoutSeconds: 1 })).json).toEqual({
      events: [],
      timedOut: true,
    });
  });

  it('refuses a delay out of 1 to 600 seconds', async () => {
    expect((await tool('wait_for_agents', { timeoutSeconds: 601 })).isError).toBe(true);
    expect((await tool('wait_for_agents', { timeoutSeconds: 0 })).isError).toBe(true);
  });

  it('keeps an event that came while it was not waiting', async () => {
    await turn();
    expect((await tool('wait_for_agents', { timeoutSeconds: 1 })).json).toMatchObject({
      events: [{ agentId: worker, kind: 'turn-finished' }],
    });
  });
});
