import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentName } from '../../../src/shared/agent-name';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, type DeliveryHarness } from './delivery-harness';

// 008 T014 — a project without a remote keeps the local merge, with the same barriers, and a project
// whose remote PACT cannot deliver to gets a refusal and no local merge (US1 sc.7, 10, 12; FR-005,
// FR-008; research R8, R19, R20).
//
// RED until DeliveryService exists (T018, T019). The API assumed is in delivery-harness.ts; here:
//   a local request waits for the user in state `reviewing` with `channel: 'local'`;
//   `decide({ deliveryId, decision: 'validate' | 'refuse', head, reason? })` is « Fusionner » /
//   « Refuser »; « Fusionner » calls `IntegrationService.start({ agentId, mode, message,
//   after: { closeTile: true, removeWorktree: false }, requestId: <delivery id> })`.

let h: DeliveryHarness;

afterEach(async () => {
  await h.dispose();
});

const startOf = () => vi.spyOn(h.integration, 'start');
const names = () => 'Faux CLI';
const todosOf = () =>
  deriveTodos(h.workspace() as never, names).filter((t) => (t.kind as string) === 'delivery-local');

describe('Given a project without a remote', () => {
  it('When delivery is requested, Then the same barriers apply (sc.7, FR-008)', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev, tester } = await h.team('a', { accept: false });
    await h.acceptLoop(dev, tester, { state: 'running' });
    const start = startOf();

    const refused = await h.request(dev.id);

    expect(refused.state).toBe('refused');
    expect(refused.reason).toContain('n’est pas acceptée');
    expect(todosOf()).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it('When changes are not committed or tests are missing, Then it is refused as with a remote', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev, tester } = await h.team('a');
    await writeFile(join(dev.worktreePath, 'brouillon.ts'), 'export const b = 1;\n');
    const dirty = await h.request(dev.id);
    expect(dirty.state).toBe('refused');
    expect(dirty.reason).toContain('Changements non commités');

    git(dev.worktreePath, 'clean', '-fdq');
    await h.commit(tester, { 'tests/b.test.ts': 'export const b = 1;\n' }, 'more tests');
    const missing = await h.request(dev.id);
    expect(missing.state).toBe('refused');
    expect(missing.reason).toContain('tests/b.test.ts');
  });

  it('When the barriers pass, Then the issue is a local merge awaiting the user: main is not touched and nothing goes to a forge', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const main = git(h.repo, 'rev-parse', 'main');
    const start = startOf();

    const delivery = await h.request(dev.id);

    expect(delivery.channel).toBe('local');
    expect(h.deliveryOf(delivery.id).state).toBe('reviewing');
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    expect(start).not.toHaveBeenCalled();
    expect(h.ghLog().filter(([a]) => a === 'pr')).toEqual([]);
    expect(h.timeline).not.toContain('pushBranch');
    const [todo] = todosOf();
    const agent = h.workspace().agents.find((a) => a.id === dev.id);
    expect(todo?.title).toBe(`◎ Fusionner ${agentName(agent as never, names)} → main ?`);
  });

  it('When Auto is on, Then it changes nothing: the merge waits for the user (FR-008)', async () => {
    h = await createDeliveryHarness({ remote: false });
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      delivery: { ...ws.delivery, auto: true },
    }));
    const { dev } = await h.team('a');
    const main = git(h.repo, 'rev-parse', 'main');
    const start = startOf();

    const delivery = await h.request(dev.id);
    await new Promise((r) => setTimeout(r, 300));

    expect(h.deliveryOf(delivery.id).state).toBe('reviewing');
    expect(start).not.toHaveBeenCalled();
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    expect(todosOf()).toHaveLength(1);
  });

  it('When the user confirms, Then the integration starts with the id of the request and the commit lands (sc.7, R20)', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const start = startOf();
    const delivery = await h.request(dev.id, { message: 'feat: connexion par e-mail' });
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');

    await h.delivery.decide({ deliveryId: delivery.id, decision: 'validate', head });

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: dev.id,
        mode: 'squash',
        message: 'feat: connexion par e-mail',
        requestId: delivery.id,
        after: { closeTile: true, removeWorktree: false },
      }),
    );
    await h.until(delivery.id, ['merged']);
    expect(git(h.repo, 'log', '-1', '--format=%s', 'main')).toBe('feat: connexion par e-mail');
    // The integration states carry the request they come from (FR-028).
    const states = h.integrations as unknown as { requestId?: string }[];
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.requestId === delivery.id)).toBe(true);
    expect(todosOf()).toEqual([]);
  });

  it('When the user clicks twice, Then one integration starts (FR-027)', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const start = startOf();
    const delivery = await h.request(dev.id);
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');

    await Promise.allSettled([
      h.delivery.decide({ deliveryId: delivery.id, decision: 'validate', head }),
      h.delivery.decide({ deliveryId: delivery.id, decision: 'validate', head }),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('When the user refuses, Then nothing is merged and the item goes away', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const main = git(h.repo, 'rev-parse', 'main');
    const start = startOf();
    const delivery = await h.request(dev.id);
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');

    await h.delivery.decide({
      deliveryId: delivery.id,
      decision: 'refuse',
      head,
      reason: 'Pas maintenant.',
    });

    expect(h.deliveryOf(delivery.id).state).toBe('user-refused');
    expect(start).not.toHaveBeenCalled();
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    expect(todosOf()).toEqual([]);
  });

  it('When the user merges without a verdict, Then it is the same item, marked, and it asks for a confirmation (sc.12)', async () => {
    h = await createDeliveryHarness({ remote: false });
    const dev = await h.addAgent('dev', { branch: 'feat/seul' });
    await h.commit(dev, { 'src/seul.ts': 'export const s = 1;\n' });
    const start = startOf();

    const delivery = await h.request(dev.id, {
      unverified: true,
      by: 'user',
      message: 'feat: seul',
    });

    expect(delivery.channel).toBe('local');
    expect(delivery.unverified).toBe(true);
    expect(h.deliveryOf(delivery.id).state).toBe('reviewing');
    const [todo] = todosOf();
    expect(todo?.title).toContain('sans verdict');
    expect(start).not.toHaveBeenCalled();

    await h.delivery.decide({
      deliveryId: delivery.id,
      decision: 'validate',
      head: git(dev.worktreePath, 'rev-parse', 'HEAD'),
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: delivery.id, message: 'feat: seul' }),
    );
  });
});

describe('Given a project whose forge PACT cannot deliver to (sc.10, Q4)', () => {
  const refusedWithoutLocalMerge = async (reason: RegExp) => {
    const { dev } = await h.team('a');
    const main = git(h.repo, 'rev-parse', 'main');
    const start = startOf();

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.channel).toBe('github');
    expect(delivery.reason).toMatch(reason);
    // No fallback on the local merge, nothing pushed, nothing to confirm.
    expect(start).not.toHaveBeenCalled();
    expect(git(h.repo, 'rev-parse', 'main')).toBe(main);
    expect(h.remoteHead(dev.branch)).toBeNull();
    expect(todosOf()).toEqual([]);
    expect(h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create')).toEqual([]);
  };

  it('When the remote is not on GitHub, Then it is refused with the reason and the way out', async () => {
    h = await createDeliveryHarness({ ghRemote: 'https://gitlab.com/pact/test' });
    await refusedWithoutLocalMerge(/pas sur GitHub[\s\S]*GitHub/);
  });

  it('When gh is not connected, Then it is refused and says how to connect it', async () => {
    h = await createDeliveryHarness();
    h.setGhState({ loggedIn: false });
    await refusedWithoutLocalMerge(/gh auth login/);
  });

  it('When gh is absent, Then it is refused and says how to install it', async () => {
    h = await createDeliveryHarness({ ghMissing: true });
    await refusedWithoutLocalMerge(/Installe gh/);
  });
});
