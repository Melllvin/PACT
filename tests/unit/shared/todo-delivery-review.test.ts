import { describe, expect, it } from 'vitest';
import { deriveTodos } from '../../../src/shared/todo';
import type { Agent } from '../../../src/shared/model';

// 008 data-model — « ◎ Relire la PR #n »: the PR of a request that asks for the eyes of the user.
// The buttons (Valider, Refuser, Ouvrir) come with the review of phase 6; here the item is shown.

const dev = { id: 'a1', role: 'dev', state: 'done', cliId: 'claude-code', position: 1 } as Agent;
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const PUSHED = '1234567fedcba9876543210fedcba9876543210f';
const names = () => 'Claude Code';
const github = (overrides: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'a1',
  channel: 'github',
  state: 'watching',
  unverified: true,
  issueId: '0012-connexion',
  branch: 'feat/a',
  frozenCommit: HEAD,
  pushedHead: PUSHED,
  pr: { number: 3, url: 'https://github.com/o/r/pull/3', expectedAuthor: 'me' },
  review: { required: true, refusedOnce: false },
  ...overrides,
});
const kinds = (deliveries: unknown[]) =>
  deriveTodos(
    { agents: [dev], freeTerminals: [], mainBranch: 'main', deliveries } as never,
    names,
  ).map((t) => t.kind);
const first = (deliveries: unknown[]) =>
  deriveTodos(
    { agents: [dev], freeTerminals: [], mainBranch: 'main', deliveries } as never,
    names,
  ).find((t) => t.kind === 'delivery-review');

describe('« ◎ Relire la PR #n »', () => {
  it('Given a PR without a verdict being watched, When the items are derived, Then one asks for a review', () => {
    expect(first([github()])).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222:delivery-review',
      agentId: 'a1',
      title: '◎ Relire la PR #3 · 0012-connexion · 1234567 · sans verdict',
      actions: [],
    });
  });

  it('Given a verdict and no issue, When the items are derived, Then the branch and the frozen commit are shown', () => {
    expect(first([github({ unverified: false, issueId: null, pushedHead: null })])?.title).toBe(
      '◎ Relire la PR #3 · feat/a · abcdef0',
    );
  });

  it.each([
    ['a request that does not ask for it', { review: { required: false, refusedOnce: false } }],
    ['a request not yet watched', { state: 'opening' }],
    ['a request without a PR', { pr: null }],
    ['a request of a dev that is gone', { agentId: 'a9' }],
    ['a request of the workflow, which has no agent (010)', { agentId: null, source: 'workflow' }],
    ['a request of the local channel', { channel: 'local', state: 'merged' }],
  ])('Given %s, When the items are derived, Then none asks for a review', (_what, change) => {
    expect(kinds([github(change)])).not.toContain('delivery-review');
  });
});
