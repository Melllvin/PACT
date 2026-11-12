import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';

// 008 US8 — the item « ◆ Worktree gardé », derived from a merged delivery whose cleanup kept a worktree.

const DEV = '00000000-0000-4000-8000-000000000001';
const TESTER = '00000000-0000-4000-8000-000000000002';
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const PUSHED = '0123456789abcdef0123456789abcdef01234567';

const agent = (id: string, position: number) => ({
  id,
  position,
  cliId: 'fake',
  role: 'dev',
  state: 'closed',
});

const workspace = (agents: unknown[], delivery: Record<string, unknown>): Workspace =>
  ({
    id: 'w1',
    agents,
    freeTerminals: [],
    loops: [],
    issues: [],
    integrationRequests: [],
    publishRequests: [],
    exchanges: { messages: [], escalations: [] },
    deliveries: [
      {
        id: 'd1',
        agentId: DEV,
        testAgentId: TESTER,
        channel: 'github',
        pr: { number: 7, url: 'https://example.test/pull/7', expectedAuthor: 'me' },
        state: 'merged',
        frozenCommit: HEAD,
        pushedHead: PUSHED,
        branch: 'feat/x',
        cleanup: 'kept',
        ...delivery,
      },
    ],
  }) as unknown as Workspace;

const names = () => 'Fake';
const kept = (ws: Workspace) => deriveTodos(ws, names).filter((t) => t.kind === 'worktree-kept');

describe('the item « Worktree gardé »', () => {
  it('Given a kept worktree, When the items are derived, Then one item per kept agent says who and why, with the head PACT pushed', () => {
    const items = kept(
      workspace([agent(DEV, 1), agent(TESTER, 2)], {
        kept: [
          { agentId: DEV, reason: 'notes.txt non suivi' },
          { agentId: TESTER, reason: 'a.test.ts absent de la PR' },
        ],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: `d1:${DEV}:worktree-kept`,
      agentId: DEV,
      title: expect.stringContaining('notes.txt non suivi') as string,
      delivery: { id: 'd1', head: PUSHED },
    });
    expect(items[1]?.agentId).toBe(TESTER);
  });

  it('Given a head PACT did not push, When the items are derived, Then the frozen commit stands for it', () => {
    const items = kept(
      workspace([agent(DEV, 1)], {
        pushedHead: null,
        kept: [{ agentId: DEV, reason: 'x' }],
      }),
    );

    expect(items[0]?.delivery?.head).toBe(HEAD);
  });

  it('Given a closed agent whose tile is forgotten, When the items are derived, Then the worktree noted at the merge names it', () => {
    const items = kept(
      workspace([], {
        kept: [{ agentId: DEV, reason: 'x' }],
        worktrees: [
          {
            agentId: DEV,
            role: 'dev',
            cliId: 'fake',
            position: 3,
            worktreePath: '/w/dev',
            branch: 'feat/x',
          },
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('Fake 3');
  });

  it('Given an agent that is neither a tile nor noted, When the items are derived, Then no item is made for it', () => {
    expect(kept(workspace([], { kept: [{ agentId: DEV, reason: 'x' }] }))).toEqual([]);
  });

  it('Given no kept worktree, a local delivery or a delivery without PR, When the items are derived, Then there is none', () => {
    expect(kept(workspace([agent(DEV, 1)], {}))).toEqual([]);
    expect(kept(workspace([agent(DEV, 1)], { kept: [] }))).toEqual([]);
    expect(
      kept(workspace([agent(DEV, 1)], { channel: 'local', kept: [{ agentId: DEV, reason: 'x' }] })),
    ).toEqual([]);
    expect(
      kept(workspace([agent(DEV, 1)], { pr: null, kept: [{ agentId: DEV, reason: 'x' }] })),
    ).toEqual([]);
  });
});
