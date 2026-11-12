import { describe, expect, it } from 'vitest';
import { deriveTodos, ORDER } from '../../../src/shared/todo';
import type { Agent } from '../../../src/shared/model';

// 008 T016 — the À faire items of the delivery (data-model TodoKind, contracts/ui.md).
//
// RED until T022. Assumed API: `deriveTodos` reads `workspace.deliveries`; a delivery of channel
// `local` in state `reviewing` is `{ id: '<delivery id>:delivery-local', kind: 'delivery-local',
// title: '◎ Fusionner <agent> → <main> ?' + ' · sans verdict' when unverified, actions: [],
// delivery: { id, head } }`, `head` = the commit the user is asked to merge (the `head` of
// `delivery:decide`). `integration-request` is gone from the kinds and from ORDER.

const dev = {
  id: 'a1',
  workspaceId: 'w1',
  position: 1,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: 'feat/a',
  worktreePath: '/w/.worktrees/claude-code-1',
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: null,
  alwaysAllowRules: [],
  state: 'working',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
  role: 'dev',
  launchedBy: null,
  closedWhileWorking: false,
  pause: null,
  effort: null,
} as Agent;

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const names = () => 'Claude Code';
const local = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  agentId: 'a1',
  channel: 'local',
  state: 'reviewing',
  unverified: false,
  frozenCommit: HEAD,
  title: 'Connexion',
  message: 'feat: connexion',
  ...overrides,
});
const workspace = (deliveries: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    agents: [dev],
    freeTerminals: [],
    mainBranch: 'main',
    deliveries,
    ...extra,
  }) as never;

describe('« ◎ Fusionner <agent> → <main> ? » (US1 sc.7, sc.12)', () => {
  it('Given a local delivery awaiting the user, When the items are derived, Then there is one, titled with the agent and the main branch', () => {
    const [todo] = deriveTodos(workspace([local()]), names);

    expect(todo).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111:delivery-local',
      agentId: 'a1',
      kind: 'delivery-local',
      title: '◎ Fusionner Claude Code 1 → main ?',
      delivery: { id: '11111111-1111-4111-8111-111111111111', head: HEAD },
    });
  });

  it('Given a local delivery without a verdict, When the items are derived, Then the title says so', () => {
    const [todo] = deriveTodos(workspace([local({ unverified: true })]), names);

    expect(todo?.kind).toBe('delivery-local');
    expect(todo?.title).toContain('sans verdict');
  });

  it.each(['checking', 'testing', 'merging', 'merged', 'user-refused', 'refused', 'dropped'])(
    'Given a local delivery in state %s, When the items are derived, Then there is no item',
    (state) => {
      const kinds = deriveTodos(workspace([local({ state })]), names).map((t) => t.kind);

      expect(kinds).not.toContain('delivery-local');
    },
  );

  it('Given a delivery of the forge, When the items are derived, Then it is not a local merge', () => {
    const kinds = deriveTodos(workspace([local({ channel: 'github' })]), names).map((t) => t.kind);

    expect(kinds).not.toContain('delivery-local');
  });

  it('Given an agent that is not in the workspace any more, When the items are derived, Then the item is dropped', () => {
    const kinds = deriveTodos(workspace([local({ agentId: 'a9' })]), names).map((t) => t.kind);

    expect(kinds).not.toContain('delivery-local');
  });

  it('Given an item awaiting the user, When the items are ordered, Then it comes where the integration request did: after the answers, before the issues to publish', () => {
    expect(ORDER).toContain('delivery-local');
    expect(ORDER.indexOf('delivery-local')).toBeGreaterThan(ORDER.indexOf('decide'));
    expect(ORDER.indexOf('delivery-local')).toBeLessThan(ORDER.indexOf('publish-issues'));
  });
});

describe('integration-request is retired (R24)', () => {
  it('Given the kinds, When ORDER is read, Then integration-request is not one', () => {
    expect(ORDER).not.toContain('integration-request');
  });

  it('Given requests left in an old workspace file, When the items are derived, Then they make no item', () => {
    const todos = deriveTodos(
      workspace([], {
        integrationRequests: [
          {
            id: 'r1',
            agentId: 'a1',
            mode: 'squash',
            message: 'feat',
            requestedAt: '2026-11-03T00:00:00.000Z',
          },
        ],
      }),
      names,
    );

    expect(todos.map((t) => t.kind as string)).not.toContain('integration-request');
  });
});
