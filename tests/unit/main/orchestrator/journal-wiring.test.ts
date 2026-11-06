import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventsTool } from '../../../../src/main/orchestrator/agent-tools';
import { createOrchestratorTools } from '../../../../src/main/orchestrator/tools';
import { LoopService } from '../../../../src/main/orchestrator/loop-service';
import { OrchestratorService } from '../../../../src/main/orchestrator/orchestrator-service';
import { IpcFailure } from '../../../../src/shared/ipc';
import type { Workspace } from '../../../../src/shared/model';

// 007 T011-T014 — the edges of the wiring around the journal: get_events when it cannot answer, an
// orchestrator with no journal, a journal that fails, a report of an agent in no workspace.

const READER = '00000000-0000-4000-8000-000000000001';
const WS = 'w1';

const text = (result: { content: { text: string }[] }) => result.content[0]?.text ?? '';

describe('get_events when it cannot answer', () => {
  const reads = (over: Record<string, unknown> = {}) =>
    ({
      workspaceOf: () => WS,
      read: vi.fn(() => Promise.resolve({ events: [], remaining: 0 })),
      detail: vi.fn(),
      ...over,
    }) as never;

  it('refuses a reader that left its workspace', async () => {
    const tool = createEventsTool(reads({ workspaceOf: () => undefined }), READER);
    const result = await tool.call({});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/workspace/);
  });

  it('reads the unread when it is called with no arguments at all', async () => {
    const result = await createEventsTool(reads(), READER).call(null);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('Aucun événement non lu.');
  });

  it('refuses an id that is not a text', async () => {
    const result = await createEventsTool(reads(), READER).call({ id: 12 });
    expect(result.isError).toBe(true);
  });

  it('gives the reason of a refused detail', async () => {
    const detail = vi.fn(() =>
      Promise.reject(new IpcFailure('NOT_FOUND', 'Événement introuvable.')),
    );
    const result = await createEventsTool(reads({ detail }), READER).call({ id: 'x' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Événement introuvable.');
  });

  it('lets an unexpected failure through', async () => {
    const read = vi.fn(() => Promise.reject(new Error('disque plein')));
    await expect(createEventsTool(reads({ read }), READER).call({})).rejects.toThrow(
      'disque plein',
    );
  });

  it('says what remains to read, and that nothing is unread', async () => {
    const some = reads({
      read: () => Promise.resolve({ events: [{ id: 'e1' }], remaining: 4 }),
    });
    expect(text(await createEventsTool(some, READER).call({}))).toContain('4 autre(s)');
    expect(text(await createEventsTool(reads(), READER).call({}))).toBe('Aucun événement non lu.');
  });
});

describe('the tools of the orchestrator', () => {
  const names = (exchanges?: unknown) =>
    createOrchestratorTools({ ...(exchanges ? { exchanges } : {}) } as never, READER).map(
      (tool) => tool.name,
    );

  it('read their events with get_events when a journal is there', () => {
    expect(names({})).toContain('get_events');
  });

  it('have no get_events without a journal', () => {
    expect(names()).not.toContain('get_events');
    expect(names()).toContain('wait_for_agents');
  });
});

describe('OrchestratorService around the journal', () => {
  const workspace = {
    id: WS,
    agents: [{ id: READER, role: 'orchestrator' }, { id: 'worker' }],
  } as unknown as Workspace;
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pact-journal-wiring-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const create = (exchanges?: Record<string, unknown>) =>
    new OrchestratorService({
      hooks: {
        registerMcp: () => 'token',
        revokeMcp: vi.fn(),
        mcpUrl: () => 'http://127.0.0.1:1/mcp',
      },
      workspaces: { list: () => [workspace] },
      rolesDir: join(root, 'roles'),
      skillsDir: 'resources/skills',
      onTurnFinished: () => undefined,
      ...(exchanges ? { exchanges: exchanges as never } : {}),
    });

  it('gives back control at once when it has no journal', async () => {
    const orchestrator = create();
    await orchestrator.prepare({ id: READER, workspaceId: WS });
    expect(await orchestrator.wait(READER, undefined, 1000)).toMatchObject({
      events: [],
      timedOut: true,
    });
  });

  it('is not stopped by a journal that fails to write or to forget', async () => {
    const exchanges = {
      record: vi.fn(() => Promise.reject(new Error('disque plein'))),
      forget: vi.fn(() => Promise.reject(new Error('disque plein'))),
      wait: vi.fn(),
      cancelWait: vi.fn(),
    };
    const orchestrator = create(exchanges);
    await orchestrator.prepare({ id: READER, workspaceId: WS });
    orchestrator.agentState({ agentId: 'worker', state: 'closed', lastError: null });
    await vi.waitFor(() => {
      expect(exchanges.record).toHaveBeenCalled();
      expect(exchanges.forget).toHaveBeenCalledWith(WS, 'worker');
    });
  });
});

describe('a report of an agent that is in no workspace', () => {
  it('tells nobody', async () => {
    const notify = vi.fn();
    const loops = new LoopService({
      workspaces: { get: () => undefined, list: () => [], update: vi.fn() },
      notify,
    } as never);
    await expect(
      loops.report('ghost', {
        status: 'done',
        summary: 'Fait',
        questions: [],
        files: [],
        checks: [],
      } as never),
    ).resolves.toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
