import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeService } from '../../../../src/main/orchestrator/exchange-service';
import { OrchestratorService } from '../../../../src/main/orchestrator/orchestrator-service';
import { createOrchestratorTools } from '../../../../src/main/orchestrator/tools';
import { GitService } from '../../../../src/main/git/git-service';
import type { Workspace } from '../../../../src/shared/model';

// 008 T018-T020 — the branches the delivery adds around the journal, the tools and the git helpers:
// what an event of integration or of delivery looks like to the orchestrator.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LEAD = uuid(1);
const DEV = uuid(2);
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

const workspace = (): Workspace =>
  ({
    id: 'w1',
    status: 'available',
    mainBranch: 'main',
    agents: [
      { id: LEAD, workspaceId: 'w1', position: 1, cliId: 'fake', role: 'orchestrator' },
      { id: DEV, workspaceId: 'w1', position: 2, cliId: 'fake', role: 'dev' },
    ],
    loops: [{ issueId: '0012-a', devAgentId: DEV, testAgentId: uuid(3), state: 'accepted' }],
    deliveries: [],
    exchanges: { messages: [], escalations: [] },
  }) as unknown as Workspace;

describe('the journal records the outcome of an integration and of a delivery', () => {
  let current: Workspace;
  let journal: ExchangeService;
  beforeEach(() => {
    current = workspace();
    journal = new ExchangeService({
      workspaces: {
        get: () => current,
        list: () => [current],
        update: (_id, change) => {
          current = change(current);
          return Promise.resolve(current);
        },
      },
      onChange: () => undefined,
      head: () => Promise.resolve(null),
      name: () => 'Faux CLI',
    });
  });

  it('Given an integration and a delivery told to the orchestrator, When it reads, Then both outcomes are in the events', async () => {
    await journal.record('w1', {
      from: 'pact',
      to: LEAD,
      about: DEV,
      kind: 'integration',
      text: 'Intégré',
      integration: { outcome: 'integrated', commit: COMMIT },
    });
    await journal.record('w1', {
      from: 'pact',
      to: LEAD,
      about: DEV,
      kind: 'delivery',
      text: 'PR ouverte',
      delivery: { id: uuid(9), outcome: 'pr-opened', pr: { number: 3, url: 'https://x/3' } },
    });
    await journal.record('w1', { from: 'pact', to: LEAD, kind: 'delivery', text: 'Rien' });

    const { events } = await journal.read('w1', LEAD);

    expect(events.map((e) => e.integration?.outcome)).toEqual(['integrated', undefined, undefined]);
    expect(events.map((e) => e.delivery?.outcome)).toEqual([undefined, 'pr-opened', undefined]);
  });
});

describe('the orchestrator hears of an integration', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pact-delivery-wiring-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('Given an event with an integration, When it is pushed, Then the journal keeps the outcome', async () => {
    const record = vi.fn(() => Promise.resolve({}));
    const orchestrator = new OrchestratorService({
      hooks: {
        registerMcp: () => 'token',
        revokeMcp: vi.fn(),
        mcpUrl: () => 'http://127.0.0.1:1/mcp',
      },
      workspaces: { list: () => [] },
      rolesDir: join(root, 'roles'),
      skillsDir: 'resources/skills',
      onTurnFinished: () => undefined,
      exchanges: { record, cancelWait: vi.fn() },
    } as never);
    await orchestrator.prepare({ id: LEAD, workspaceId: 'w1' });

    orchestrator.push('w1', {
      at: new Date().toISOString(),
      agentId: DEV,
      kind: 'integration',
      state: 'done',
      summary: 'Intégré',
      integration: { outcome: 'integrated' },
    });

    expect(record).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ kind: 'integration', integration: { outcome: 'integrated' } }),
    );
  });
});

describe('what the orchestrator reads of the events', () => {
  const tools = (events: unknown[], delivery?: unknown) =>
    createOrchestratorTools(
      {
        workspaces: { list: () => [workspace()] },
        cliName: () => 'Faux CLI',
        wait: () => Promise.resolve({ events, remaining: 0, timedOut: false }),
        delivery: delivery ?? {
          request: () => Promise.resolve({ id: uuid(9), state: 'refused', reason: null }),
        },
        log: vi.fn(),
      } as never,
      LEAD,
    );
  const call = (list: ReturnType<typeof tools>, name: string, args: unknown) =>
    list.find((t) => t.name === name)?.call(args);

  it('Given integration and delivery events, When the orchestrator waits, Then each one is a line', async () => {
    const list = tools([
      {
        about: DEV,
        kind: 'integration',
        summary: 'Intégré',
        integration: { outcome: 'integrated' },
      },
      { about: DEV, kind: 'integration', summary: 'Sans issue' },
      { about: DEV, kind: 'delivery', summary: 'PR #3 ouverte' },
    ]);

    const result = await call(list, 'wait_for_agents', {});

    const text = result?.content[0]?.text ?? '';
    expect(text).toContain('intégration integrated. Intégré');
    expect(text).toContain('intégration . Sans issue');
    expect(text).toContain('PR #3 ouverte');
  });

  it('Given a refusal that gives no reason, When the orchestrator asks for a delivery, Then it reads a default one', async () => {
    const result = await call(tools([]), 'request_delivery', {
      issue: '0012-a',
      title: 'A',
      message: 'feat: a',
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toBe('La livraison est refusée.');
  });
});

describe('GitService.hasOrigin', () => {
  it('Given a folder that is not a repository, When asked, Then there is no origin', async () => {
    const git = new GitService({ env: process.env });

    expect(await git.hasOrigin(join(tmpdir(), 'pact-no-such-repo-008'))).toBe(false);
  });
});
