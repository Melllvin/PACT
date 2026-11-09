import { describe, expect, it } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent, Workspace } from '../../../src/shared/model';

// 008 T045 — the items of a CI that is silent and of a PR brought up to date again and again (US4 sc.2, sc.5).

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const names = () => 'Claude Code';
const dev = {
  id: 'a2',
  workspaceId: 'w1',
  position: 2,
  cliId: 'claude-code',
  state: 'done',
  role: 'dev',
} as unknown as Agent;
const workspace = (deliveries: unknown[]) =>
  ({
    agents: [dev],
    freeTerminals: [],
    mainBranch: 'main',
    deliveries,
  }) as unknown as Pick<Workspace, 'agents' | 'freeTerminals' | 'mainBranch' | 'deliveries'>;
const request = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  agentId: 'a2',
  channel: 'github',
  state: 'watching',
  unverified: false,
  issueId: '0012-connexion',
  branch: 'feat/a',
  frozenCommit: HEAD,
  pushedHead: HEAD,
  pr: { number: 7, url: 'https://github.com/pact/test/pull/7', expectedAuthor: 'me' },
  ci: { head: HEAD, verdict: 'silent' },
  review: { required: false, refusedOnce: false },
  rebases: 0,
  ...overrides,
});

describe('« ◆ CI muette »', () => {
  it('Given a silent CI on the head of a watched PR, When the items are derived, Then one asks to wait or to read, with the PR', () => {
    const todos = deriveTodos(workspace([request()]), names);

    expect(todos).toEqual([
      {
        id: 'r1:delivery-silent-ci',
        agentId: 'a2',
        kind: 'delivery-silent-ci',
        title: '◆ CI muette · PR #7 · 10 min sans check',
        actions: [],
        delivery: { id: 'r1', head: HEAD, url: 'https://github.com/pact/test/pull/7' },
      },
    ]);
  });

  it('Given a silence read on another head, a CI not silent, or a request that is no longer watched, Then there is no item', () => {
    const other = 'f'.repeat(40);
    const todos = deriveTodos(
      workspace([
        request({ ci: { head: other, verdict: 'silent' } }),
        request({ id: 'r2', ci: { head: HEAD, verdict: 'pending' } }),
        request({ id: 'r3', state: 'ci-red' }),
        request({ id: 'r4', pr: null, state: 'syncing' }),
      ]),
      names,
    );

    expect(todos).toEqual([]);
  });
});

describe('« ◆ Livraison » after the third rebase in a row', () => {
  it('Given three rebases, When the request is watched or waits for a review, Then the alert is there, before the review item', () => {
    const todos = deriveTodos(
      workspace([
        request({ rebases: 3, ci: null }),
        request({ id: 'r2', state: 'reviewing', rebases: 4, ci: null }),
      ]),
      names,
    );

    expect(todos.map((t) => t.id)).toEqual([
      'r2:delivery-review',
      'r1:delivery-alert',
      'r2:delivery-alert',
    ]);
    expect(todos.find((t) => t.id === 'r1:delivery-alert')).toMatchObject({
      kind: 'delivery-alert',
      title: '◆ Livraison · 0012-connexion · 3 recalages de suite',
      delivery: { id: 'r1', head: HEAD, url: 'https://github.com/pact/test/pull/7' },
    });
    expect(todos.find((t) => t.id === 'r2:delivery-review')?.delivery?.verdict).toBe('accepted');
  });

  it('Given two rebases, or a request that ended, Then there is no alert', () => {
    const todos = deriveTodos(
      workspace([
        request({ rebases: 2, ci: null }),
        request({ id: 'r2', rebases: 3, state: 'merged', ci: null }),
      ]),
      names,
    );

    expect(todos).toEqual([]);
  });
});
