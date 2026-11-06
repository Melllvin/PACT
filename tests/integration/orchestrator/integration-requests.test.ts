import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFailure } from '../../../src/shared/ipc';
import { callTool, createHarness, git, type Harness } from './harness';

// 003 T030 — request_integration, then the user's confirmation or refusal, and the outcome the
// orchestrator hears of (FR-017…FR-020, R6).

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
  // The agent writes src/données à jour.ts during its turn (scenario edit-echo).
  h.pty.write(worker, 'Écris\r');
  await h.waitForState(worker, 'done');
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const requestsOf = () => h.workspaces.get(h.workspace.id)?.integrationRequests ?? [];

const ask = async (message = 'feat: données à jour') => {
  const { isError, json } = await tool('request_integration', { agent: 'Faux CLI 2', message });
  expect(isError).toBe(false);
  return json as { requestId: string; status: string };
};

/** The integration events the orchestrator reads with wait_for_agents. */
/** 007: an event of the journal, as `wait_for_agents` gives it. */
type JournalEvent = {
  kind: string;
  about?: string;
  summary: string;
  integration?: { outcome: string; commit?: string; files?: string[] };
};

const heard = async () => {
  const { json } = await tool('wait_for_agents', { timeoutSeconds: 5 });
  return (json as { events: JournalEvent[] }).events.filter((e) => e.kind === 'integration');
};

describe('request_integration', () => {
  it('keeps a request for the user and leaves main as it was', async () => {
    const main = git(h.repo, 'rev-parse', 'main');
    const { requestId, status } = await ask();
    expect(status).toBe('waiting-user');
    expect(requestsOf()).toEqual([
      expect.objectContaining({
        id: requestId,
        agentId: worker,
        mode: 'squash',
        message: 'feat: données à jour',
      }),
    ]);
    expect(h.announced.at(-1)).toEqual(requestsOf());
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    const saved = await h.stores.workspace(h.workspace.id).read();
    expect(saved?.integrationRequests.map((r) => r.id)).toEqual([requestId]);
  });

  it('replaces the request of the same agent', async () => {
    const first = await ask('feat: un');
    const second = await ask('feat: deux');
    expect(second.requestId).not.toBe(first.requestId);
    expect(requestsOf().map((r) => r.message)).toEqual(['feat: deux']);
  });

  it('is refused for the orchestrator itself, or without a message', async () => {
    expect((await tool('request_integration', { agent: 'Faux CLI 1', message: 'x' })).isError).toBe(
      true,
    );
    expect((await tool('request_integration', { agent: 'Faux CLI 2', message: ' ' })).isError).toBe(
      true,
    );
    const mode = await tool('request_integration', {
      agent: 'Faux CLI 2',
      message: 'feat',
      mode: 'rebase',
    });
    expect(mode.isError).toBe(true);
    expect(requestsOf()).toEqual([]);
  });
});

describe('the user’s answer', () => {
  it('confirmed, integrates with the message kept and tells the orchestrator the commit', async () => {
    const { requestId } = await ask();
    const integration = await h.requests.confirm({ requestId, message: 'feat: relu' });
    expect(integration.state).toBe('integrated');
    expect(git(h.repo, 'log', '-1', '--format=%s', 'main')).toBe('feat: relu');
    expect(requestsOf()).toEqual([]);
    const [event] = await heard();
    // 007: the events come from the journal, where the agent concerned is `about`.
    expect(event).toMatchObject({
      about: worker,
      integration: { outcome: 'integrated', commit: git(h.repo, 'rev-parse', 'main') },
    });
    // R6: the tile is closed, the worktree kept.
    await h.waitFor(() => h.current(worker) === undefined, 'the tile stayed');
    expect(git(h.repo, 'worktree', 'list')).toContain('worktrees');
  });

  it('refused, integrates nothing and tells the orchestrator', async () => {
    const main = git(h.repo, 'rev-parse', 'main');
    const { requestId } = await ask();
    await h.requests.refuse({ requestId });
    expect(requestsOf()).toEqual([]);
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    expect(await heard()).toEqual([
      expect.objectContaining({ about: worker, integration: { outcome: 'refused' } }),
    ]);
    await expect(h.requests.refuse({ requestId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('tells the conflicting files', async () => {
    // main gets its own version of the file the agent wrote.
    await mkdir(join(h.repo, 'src'), { recursive: true });
    await writeFile(join(h.repo, 'src', 'données à jour.ts'), 'autre chose\n');
    git(h.repo, 'add', '.');
    git(h.repo, 'commit', '-m', 'main aussi');
    const { requestId } = await ask();
    const integration = await h.requests.confirm({ requestId, message: 'feat' });
    expect(integration.state).toBe('conflicted');
    expect(await heard()).toEqual([
      expect.objectContaining({
        integration: { outcome: 'conflicted', files: ['src/données à jour.ts'] },
      }),
    ]);
  });

  it('tells why it failed, main as it was', async () => {
    const main = git(h.repo, 'rev-parse', 'main');
    const hook = join(h.repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "lint en échec" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const { requestId } = await ask();
    await expect(h.requests.confirm({ requestId, message: 'feat' })).rejects.toThrow(
      'lint en échec',
    );
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    const [event] = await heard();
    expect(event?.integration?.outcome).toBe('failed');
    expect(event?.summary).toContain('lint en échec');
  });

  it('keeps the request when the integration cannot start', async () => {
    const { requestId } = await ask();
    // As when the agent works again and the user did not confirm it (002 FR-024).
    vi.spyOn(h.integration, 'start').mockRejectedValueOnce(
      new IpcFailure('INVALID_INPUT', 'L’agent travaille encore : confirmer l’intégration.'),
    );
    await expect(h.requests.confirm({ requestId, message: 'feat' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(requestsOf().map((r) => r.id)).toEqual([requestId]);
  });
});

describe('a request', () => {
  it('goes with its agent when it is closed', async () => {
    await ask();
    await h.manager.close(worker, { removeWorktree: true });
    await h.waitFor(() => h.announced.at(-1)?.length === 0, 'the request stayed');
    expect(requestsOf()).toEqual([]);
  });

  it('comes back after a restart', async () => {
    const { requestId } = await ask();
    await h.restart();
    expect(requestsOf().map((r) => r.id)).toEqual([requestId]);
    const saved = await h.stores.workspace(h.workspace.id).read();
    expect(saved?.integrationRequests.map((r) => r.id)).toEqual([requestId]);
  });
});
