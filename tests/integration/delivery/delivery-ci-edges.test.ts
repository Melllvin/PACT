import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTools } from '../../../src/main/orchestrator/agent-tools';
import { IpcFailure } from '../../../src/shared/ipc';
import type { Delivery } from '../../../src/shared/delivery';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, type DeliveryHarness } from './delivery-harness';

// 008 phase 7 — the edges of the rebase after the PR, of the answers to the items of the CI and of the
// log of a check (US4 sc.3, 5, 8). The main cases are in delivery-ci-states.test.ts and
// agent-tools-ci-log.test.ts; these are the ways out of them: red tests on R, a push that loses its lease,
// a PR that is already up to date, a PR under review, a merge under way, « Compris », a refused request
// with no PR, a check that did not fail, a forge that does not answer.

let h: DeliveryHarness;
afterEach(async () => {
  await h.dispose();
});

const names = () => 'Fake';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const itemsOf = (kind: string): TodoItem[] =>
  deriveTodos(h.workspace(), names).filter((t) => (t.kind as string) === kind);
const decide = (id: string, decision: 'wait' | 'review' | 'validate', head = h.prHead(1)) =>
  (
    h.delivery as unknown as {
      decide(input: { deliveryId: string; decision: string; head: string }): Promise<Delivery>;
    }
  ).decide({ deliveryId: id, decision, head });

async function watching(suffix = 'a') {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  const delivery = await h.until(request.id, ['watching']);
  return { ...team, id: delivery.id, head: h.prHead(1) };
}

describe('the rebase after the PR meets red tests, a lost lease, a PR up to date (sc.5)', () => {
  it('Given main brings a change that turns the tests of PACT red, When PACT brings the PR up to date, Then the request is tests-failed, a round is counted and nothing is pushed', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head, dev } = await watching();
    h.setChecks(head, h.RUNNING);
    h.pushToOrigin('main', { FAIL: 'rouge\n' }, 'main breaks the tests');
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });

    await h.until(id, ['tests-failed']);

    expect(h.workspace().loops[0]?.round).toBe(2);
    expect(h.deliveryOf(id).rebases).toBe(0);
    expect(h.prHead(1)).toBe(head);
    expect(h.messagesTo(dev.id).some((m) => m.text.includes('Tests rouges'))).toBe(true);
  });

  it('Given the branch moves while the tests of the rebase run, When PACT pushes, Then the lease fails, the request is refused and the PR stays as it is', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    h.setChecks(head, h.RUNNING);
    const hold = h.holdTests();
    const runs = h.testRuns.length;
    h.pushToOrigin('main', { 'docs/note.md': 'une note\n' }, 'main moves');
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });
    await h.waitFor(() => h.testRuns.length > runs, 'the tests of the rebase did not start');

    h.pushToOrigin('feat/a', { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');
    hold.release();
    const done = await h.until(id, ['refused']);

    expect(done.reason).toContain('feat/a');
    expect(h.deliveryOf(id).rebases).toBe(0);
    expect(h.mergeCalls()).toHaveLength(0);
  });

  it('Given a PR BEHIND on a main that PACT already contains, When PACT reads it, Then nothing is rebased and the CI goes on being read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    const runs = h.testRuns.length;
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });
    h.setChecks(head, h.GREEN);

    await h.until(id, ['reviewing']);

    expect(h.deliveryOf(id).rebases).toBe(0);
    expect(h.testRuns).toHaveLength(runs);
    expect(h.prHead(1)).toBe(head);
  });

  it('Given a PR without a verdict, When main moves and the PR is BEHIND, Then it is rebased and still has no verdict to carry', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const team = await h.team('a');
    const request = await h.request(team.dev.id, { unverified: true });
    const { id } = await h.until(request.id, ['watching']);
    h.setChecks(h.prHead(1), h.RUNNING);
    h.pushToOrigin('main', { 'docs/note.md': 'une note\n' }, 'main moves');
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });

    await h.waitFor(() => h.deliveryOf(id).rebases === 1, 'no rebase was counted');

    expect(h.deliveryOf(id).verdictCommit).toBeNull();
    expect(h.deliveryOf(id).pushedHead).toBe(h.remoteHead('feat/a'));
  });

  it('Given a PR waiting for a review, When main moves and the PR is BEHIND, Then it is rebased, watched again, and the review is asked again on the new green', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    h.setChecks(head, h.GREEN);
    await h.until(id, ['reviewing']);
    expect(itemsOf('delivery-review')).toHaveLength(1);

    h.pushToOrigin('main', { 'docs/note.md': 'une note\n' }, 'main moves');
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });
    await h.waitFor(() => h.deliveryOf(id).rebases === 1, 'no rebase was counted');
    await h.until(id, ['watching']);
    // The fake settles the status of the PR at its next call; the next write of the test waits for it.
    await h.waitFor(
      () =>
        h.prHead(1) === h.deliveryOf(id).pushedHead && h.deliveryOf(id).ci?.head === h.prHead(1),
      'the new head was not read',
    );
    await sleep(200);

    expect(itemsOf('delivery-review')).toHaveLength(0);
    h.setChecks(h.prHead(1), h.GREEN);
    await h.until(id, ['reviewing']);
    expect(itemsOf('delivery-review')).toHaveLength(1);
  });

  it('Given the user validates and the merge is under way, When the PR turns BEHIND meanwhile, Then PACT does not rebase under the merge', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    h.setChecks(head, h.GREEN);
    await h.until(id, ['reviewing']);
    const hold = h.holdGh((args) => args[0] === 'pr' && args[1] === 'merge');
    const validating = decide(id, 'validate');
    await hold.reached;

    h.pushToOrigin('main', { 'docs/note.md': 'une note\n' }, 'main moves');
    h.patchPr(1, { mergeStateStatus: 'BEHIND' });
    const views = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'view').length;
    const seen = views();
    await h.waitFor(() => views() >= seen + 3, 'the PR was not read again');
    hold.release();
    await validating;
    await h.until(id, ['merged']);

    expect(h.deliveryOf(id).rebases).toBe(0);
    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
  });
});

describe('« Compris » and the second click (sc.2, sc.5)', () => {
  it('Given the alert of three rebases, When the user answers « Compris », Then the count starts again and the item goes; a second answer changes nothing', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    h.setChecks(head, h.RUNNING);
    for (const n of [1, 2, 3]) {
      h.pushToOrigin(
        'main',
        { [`docs/n${String(n)}.md`]: `${String(n)}\n` },
        `main moves ${String(n)}`,
      );
      h.patchPr(1, { mergeStateStatus: 'BEHIND' });
      await h.waitFor(() => h.deliveryOf(id).rebases === n, `rebase ${String(n)} not counted`);
      await h.waitFor(
        () =>
          h.prHead(1) === h.deliveryOf(id).pushedHead && h.deliveryOf(id).ci?.head === h.prHead(1),
        'the new head was not read',
      );
      await sleep(200);
    }
    expect(itemsOf('delivery-alert')).toHaveLength(1);

    await decide(id, 'wait');
    const again = await decide(id, 'wait');

    expect(h.deliveryOf(id).rebases).toBe(0);
    expect(itemsOf('delivery-alert')).toHaveLength(0);
    expect(again.rebases).toBe(0);
    expect(h.deliveryOf(id).state).toBe('watching');
  });

  it('Given a CI that is not silent, When the user answers « Attendre encore » anyway, Then nothing changes', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id } = await watching();
    const before = h.deliveryOf(id).ci;

    const answered = await decide(id, 'wait');

    expect(answered.state).toBe('watching');
    expect(answered.rebases).toBe(0);
    expect(h.deliveryOf(id).ci?.emptySince ?? null).toBe(before?.emptySince ?? null);
  });

  it('Given a local delivery, When « wait » or « review » is sent, Then it is refused: those answers are about a PR', async () => {
    h = await createDeliveryHarness({ remote: false });
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    expect(request.channel).toBe('local');

    await expect(
      (
        h.delivery as unknown as {
          decide(input: { deliveryId: string; decision: string; head: string }): Promise<Delivery>;
        }
      ).decide({ deliveryId: request.id, decision: 'wait', head: request.frozenCommit }),
    ).rejects.toBeInstanceOf(IpcFailure);
  });
});

describe('get_ci_log refuses what is not a failed job of the PR of the dev (sc.8)', () => {
  const failing = { id: 77, name: 'ci', status: 'completed', conclusion: 'failure' };
  const toolOf = (agentId: string) =>
    createAgentTools({ delivery: h.delivery }, agentId).find((t) => t.name === 'get_ci_log');
  const runViews = () => h.ghLog().filter(([a, b]) => a === 'run' && b === 'view');

  async function red() {
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    await h.until(request.id, ['watching']);
    h.setChecks(h.prHead(1), [
      failing,
      { id: 78, name: 'unit', status: 'completed', conclusion: 'success' },
    ]);
    await h.until(request.id, ['ci-red']);
    return team;
  }

  it('Given a dev whose request was refused before any PR, When it asks for a log, Then it is refused', async () => {
    h = await createDeliveryHarness({ pollMs: 50, ghMissing: true });
    const team = await h.team('a');
    await h.request(team.dev.id);

    const result = await toolOf(team.dev.id)?.call({ check: 'ci' });

    expect(result?.isError).toBe(true);
    expect(runViews()).toHaveLength(0);
  });

  it('Given a check that did not fail, When the dev asks for its log, Then it is refused and nothing is read', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await red();

    const result = await toolOf(dev.id)?.call({ check: 'unit' });

    expect(result?.isError).toBe(true);
    expect(runViews()).toHaveLength(0);
  });

  it('Given a forge that does not answer when the PR is read, or when the log is read, Then the dev is told nothing could be read, and no text of the forge reaches it', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await red();
    h.beforeGh(
      (args) => args[0] === 'pr' && args[1] === 'view',
      () => Promise.reject(new Error('PACT-INJECTION-WITNESS')),
    );
    const first = await toolOf(dev.id)?.call({ check: 'ci' });
    h.beforeGh(
      (args) => args[0] === 'run' && args[1] === 'view',
      () => Promise.reject(new Error('PACT-INJECTION-WITNESS')),
    );
    const second = await toolOf(dev.id)?.call({ check: 'ci' });

    for (const result of [first, second]) {
      expect(result?.isError).toBe(true);
      expect(result?.content[0]?.text).toBe('Le journal n’a pas pu être lu.');
    }
  });
});
