import { afterEach, describe, expect, it } from 'vitest';
import { IpcFailure } from '../../../src/shared/ipc';
import { checkName } from '../../../src/shared/delivery';
import type { Delivery } from '../../../src/shared/delivery';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, tryGit, type DeliveryHarness } from './delivery-harness';

// 008 T041 — User Story 4: a CI absent, silent or red (sc.1 to 7, research R10). A repository, a bare
// remote, the contractual fake `gh` over a JSON file, the real services around. Nothing real, no `--auto`,
// no `refs/pull/*`. The CI is driven by the test (`setChecks`); the watcher reads every 50 ms (`pollMs`).
//
// RED until T044. THE API THIS FILE ASSUMES (fixed by data-model.md, contracts/ui.md and research R9, R10):
//   - a CI configured (a workflow on origin/<target>, or required checks, or a protection PACT cannot
//     read) that shows no check for SILENT_CI_MS gives the verdict `silent`, and the item `delivery-silent-ci`
//     (title « ◆ CI muette · PR #<n> · 10 min sans check », `delivery: { id, head, url }`) in À faire.
//     The request stays `watching`; PACT merges nothing by itself, Auto or not.
//   - delivery.decide({ deliveryId, decision: 'wait' | 'review', head }) answers that item: `wait` pushes
//     `ci.emptySince` back to now (the item goes, comes back after 10 more minutes); `review` answers it
//     too and shows the PR (`prUrl`). `validate` stays refused while the CI is not green; a PR merged on
//     the forge is seen by the watcher (`merged`, no merge call of PACT).
//   - a red CI: the check names go to the dev (bounded, quoted, with the hint of the tool `get_ci_log`), a
//     round is counted; at the ceiling, `escalated`, no new round and no message to the dev.
//   - `mergeStateStatus` BEHIND or DIRTY on a followed PR: PACT rebases the PR on origin/<target>, runs
//     the tests of PACT on R, pushes, `rebases` + 1, `verdictCommit` = R, R joins `pactCommits`, and a new
//     CI is awaited on R; no round counted. A real conflict is `conflicted` (a round is counted). The third
//     rebase in a row tells the user (outcome `alert`, item `delivery-alert`).
//   - the fake `gh` settles BEHIND/DIRTY when the branch of the PR moves (tests/fixtures/fake-cli/fake-gh.mjs).

let h: DeliveryHarness;
afterEach(async () => {
  await h.dispose();
});

const names = () => 'Fake';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messagesOf = (outcome: string) =>
  h.deliveryMessages().filter((m) => m.delivery?.outcome === outcome);
const checkRunReads = () =>
  h.ghLog().filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;
const itemsOf = (kind: string): TodoItem[] =>
  deriveTodos(h.workspace(), names).filter((t) => (t.kind as string) === kind);
const decide = (id: string, decision: 'wait' | 'review' | 'validate', head = h.prHead(1)) =>
  (
    h.delivery as unknown as {
      decide(input: { deliveryId: string; decision: string; head: string }): Promise<Delivery>;
    }
  ).decide({ deliveryId: id, decision, head });
const prUrl = (id: string) =>
  (h.delivery as unknown as { prUrl(id: string): Promise<string | null> }).prUrl(id);

/** A dev accepted and delivered: the PR is #1, watched. */
async function watching(suffix = 'a') {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  const delivery = await h.until(request.id, ['watching']);
  return { ...team, id: delivery.id, head: h.prHead(1), branch: `feat/${suffix}` };
}

const WORKFLOW = { '.github/workflows/ci.yml': 'name: ci\non: push\njobs: {}\n' };

describe('no workflow and no required check (sc.1, FR-015)', () => {
  it('Given no workflow and no required check, Auto on, When the PR is open, Then PACT merges after the verdict with no check at all', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    await h.setSettings({ auto: true });

    const { id, head } = await watching();
    const done = await h.until(id, ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
    expect(done.ci?.configured).toBe(false);
    expect(done.ci?.checks).toEqual([]);
  });

  it('Given no workflow and no required check, Auto off, When the PR is open, Then PACT asks for a review and merges nothing', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });

    const { id } = await watching();
    await h.until(id, ['reviewing']);
    await sleep(300);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(messagesOf('review-requested')).toHaveLength(1);
    expect(itemsOf('delivery-review')).toHaveLength(1);
  });
});

describe('a protection PACT cannot read counts as a CI configured (research R10, P5)', () => {
  it('Given a protection that refuses to be read and no check, Auto on, When PACT reads again and again, Then the CI is « unknown » and nothing is merged', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    h.setGhState({ protection: 'forbidden' });
    await h.setSettings({ auto: true });

    const { id } = await watching();
    const reads = checkRunReads();
    await h.waitFor(() => checkRunReads() >= reads + 3, 'the checks were not read three times');

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.deliveryOf(id).state).toBe('watching');
    expect(h.deliveryOf(id).ci?.configured).toBe('unknown');
    expect(h.deliveryOf(id).ci?.verdict).not.toBe('green');
  });

  it('Given a protection that refuses to be read, Auto on, When one check is read and green, Then PACT merges (one check read and green is enough)', async () => {
    h = await createDeliveryHarness({ pollMs: 50 });
    h.setGhState({ protection: 'forbidden' });
    await h.setSettings({ auto: true });

    const { id, head } = await watching();
    h.setChecks(head, h.GREEN);
    await h.until(id, ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
  });
});

describe('a CI configured that shows no check (sc.2, sc.7, FR-016)', () => {
  /** A workflow on the target, Auto on (to show that PACT merges nothing by itself), the silence 11 minutes old. */
  async function silent() {
    h = await createDeliveryHarness({ pollMs: 50 });
    h.pushToOrigin('main', WORKFLOW, 'workflow');
    await h.setSettings({ auto: true });
    const watched = await watching();
    await h.waitFor(
      () => h.deliveryOf(watched.id).ci?.emptySince != null,
      'no empty reading was saved',
    );
    await backdate(watched.id);
    await h.waitFor(() => itemsOf('delivery-silent-ci').length === 1, 'no silent-CI item');
    return watched;
  }
  /** The first reading without a check was 11 minutes ago: the 10 minutes of FR-016 have passed. */
  const backdate = (id: string) =>
    h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) =>
        d.id === id && d.ci
          ? { ...d, ci: { ...d.ci, emptySince: new Date(Date.now() - 11 * 60_000).toISOString() } }
          : d,
      ),
    }));

  it('Given workflows and no check, When 10 minutes pass, Then the user is told with « Attendre encore » and « Relire », and PACT merges nothing by itself', async () => {
    const { id } = await silent();
    await sleep(300);

    const [item] = itemsOf('delivery-silent-ci');
    expect(item?.title).toContain('CI muette · PR #1');
    expect(item?.title).toContain('10 min sans check');
    expect(h.deliveryOf(id).ci?.configured).toBe(true);
    expect(h.deliveryOf(id).ci?.verdict).toBe('silent');
    expect(h.deliveryOf(id).state).toBe('watching');
    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
  });

  it('Given a silent CI, When the user chooses « Attendre encore », Then the item goes, PACT keeps waiting, and it comes back after 10 more minutes', async () => {
    const { id } = await silent();

    await decide(id, 'wait');
    await h.waitFor(() => itemsOf('delivery-silent-ci').length === 0, 'the item stayed');
    const reads = checkRunReads();
    await h.waitFor(() => checkRunReads() >= reads + 3, 'the checks were not read three times');

    expect(itemsOf('delivery-silent-ci')).toHaveLength(0);
    expect(h.deliveryOf(id).state).toBe('watching');
    expect(Date.now() - Date.parse(h.deliveryOf(id).ci?.emptySince ?? '1970-01-01')).toBeLessThan(
      60_000,
    );
    expect(h.mergeCalls()).toHaveLength(0);

    await backdate(id);
    await h.waitFor(() => itemsOf('delivery-silent-ci').length === 1, 'the item did not come back');
  });

  it('Given a silent CI, When the user chooses « Relire », Then the PR is shown, « Valider » stays refused and PACT notices the merge made on the forge', async () => {
    const { id, lead } = await silent();

    await decide(id, 'review');
    expect(await prUrl(id)).toBe('https://github.com/pact/test/pull/1');
    await expect(decide(id, 'validate')).rejects.toBeInstanceOf(IpcFailure);
    expect(h.mergeCalls()).toHaveLength(0);

    h.patchPr(1, { state: 'MERGED' });
    const done = await h.until(id, ['merged']);

    expect(done.state).toBe('merged');
    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.workspace().loops[0]?.state).toBe('merged');
    expect(messagesOf('merged')[0]?.to).toBe(lead.id);
  });

  it('Given a CI configured by its required checks only, When no check shows for 10 minutes, Then the item comes too (the required check never ran)', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id } = await watching();
    await h.waitFor(() => h.deliveryOf(id).ci?.emptySince != null, 'no empty reading was saved');
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) =>
        d.id === id && d.ci
          ? { ...d, ci: { ...d.ci, emptySince: new Date(Date.now() - 11 * 60_000).toISOString() } }
          : d,
      ),
    }));

    await h.waitFor(() => itemsOf('delivery-silent-ci').length === 1, 'no silent-CI item');

    expect(h.mergeCalls()).toHaveLength(0);
  });
});

describe('a red check goes back to the dev, and the ceiling stops it (sc.3, sc.4)', () => {
  const red = (name: string, id = 11) => ({
    id,
    name,
    status: 'completed',
    conclusion: 'failure',
  });

  it('Given a check that fails, When PACT reads it, Then the dev receives the name of the check, bounded, with the way to read its log, and a round is counted', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head, dev } = await watching();
    const long = `lint-${'x'.repeat(200)}`;

    h.setChecks(head, [
      { id: 10, name: 'unit', status: 'completed', conclusion: 'success' },
      red(long),
    ]);
    await h.until(id, ['ci-red']);

    const toDev = h.messagesTo(dev.id).filter((m) => (m.kind as string) === 'verdict');
    expect(toDev).toHaveLength(1);
    const text = toDev[0]?.text ?? '';
    expect(text).toContain(`« ${checkName(long)} »`);
    expect(text).not.toContain(long);
    expect(text).not.toContain('« unit »');
    expect(text).toContain('get_ci_log');
    expect(h.workspace().loops[0]?.round).toBe(2);
    expect(h.workspace().loops[0]?.state).toBe('running');
    expect(h.mergeCalls()).toHaveLength(0);
    expect(messagesOf('ci-red')).toHaveLength(1);
  });

  it('Given the last round consumed, When the CI is still red, Then PACT escalates to the user without a new round and without a word to the dev', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    await h.setSettings({ maxRounds: 1 });
    const { id, head, dev } = await watching();

    h.setChecks(head, [red('ci')]);
    await h.until(id, ['ci-red']);

    const loop = h.workspace().loops[0];
    expect(loop?.state).toBe('escalated');
    expect(loop?.round).toBe(1);
    expect(loop?.rounds).toHaveLength(1);
    expect(h.messagesTo(dev.id).filter((m) => (m.kind as string) === 'verdict')).toHaveLength(0);
    expect(messagesOf('ci-red')[0]?.text).toContain('plafond');
    expect(itemsOf('loop-escalated')).toHaveLength(1);
  });
});

describe('main moved or a conflict: PACT brings the PR up to date (sc.5, FR-017)', () => {
  it.each(['BEHIND', 'DIRTY'] as const)(
    'Given a PR %s because main moved without conflict, When PACT reads it, Then it rebases on main, tests R, pushes, awaits a new CI, and counts no round',
    async (status) => {
      h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
      const { id, head, branch, tester } = await watching();
      h.setChecks(head, h.RUNNING);
      const main = h.pushToOrigin('main', { 'docs/note.md': 'une note\n' }, 'main moves');
      h.patchPr(1, { mergeStateStatus: status });

      await h.waitFor(() => h.deliveryOf(id).rebases === 1, 'no rebase was counted');
      const after = h.deliveryOf(id);
      const rebased = h.remoteHead(branch) ?? '';

      expect(rebased).not.toBe(head);
      expect(after.pushedHead).toBe(rebased);
      expect(tryGit(h.bare, 'merge-base', '--is-ancestor', main, rebased)).not.toBeNull();
      expect(after.verdictCommit).toBe(rebased);
      expect(after.pactCommits).toEqual(expect.arrayContaining([head, rebased]));
      expect(h.testRuns.at(-1)?.head).toBe(rebased);
      expect(after.state).toBe('watching');
      expect(h.workspace().loops[0]?.round).toBe(1);
      expect(h.workspace().loops[0]?.state).toBe('delivering');
      expect(h.messagesTo(tester.id)).toHaveLength(0);
      expect(messagesOf('alert')).toHaveLength(0);

      // The old head's green is no longer the CI of the PR: the new one is awaited.
      h.setChecks(head, h.GREEN);
      await h.waitFor(() => h.deliveryOf(id).ci?.head === rebased, 'the new head was not read');
      expect(h.deliveryOf(id).ci?.verdict).toBe('pending');
      expect(h.deliveryOf(id).state).toBe('watching');
      expect(h.mergeCalls()).toHaveLength(0);

      h.setChecks(rebased, h.GREEN);
      await h.until(id, ['reviewing']);
      expect(
        deriveTodos(h.workspace(), names).find((t) => t.kind === 'delivery-review'),
      ).toBeDefined();
    },
  );

  it('Given a PR DIRTY by a real conflict with main, When PACT tries to bring it up to date, Then the request is conflicted and a round is counted', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head, dev } = await watching();
    h.setChecks(head, h.RUNNING);
    h.pushToOrigin('main', { 'src/a.ts': 'export const a = "main";\n' }, 'main moves');
    h.patchPr(1, { mergeStateStatus: 'DIRTY' });

    await h.until(id, ['conflicted']);

    expect(h.workspace().loops[0]?.round).toBe(2);
    expect(h.workspace().loops[0]?.state).toBe('running');
    expect(h.messagesTo(dev.id).some((m) => m.text.includes('src/a.ts'))).toBe(true);
    expect(messagesOf('conflicted')).toHaveLength(1);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.remoteHead('feat/a')).toBe(head);
  });

  it('Given main that keeps moving, When PACT brings the PR up to date a third time in a row, Then the user is told, and not before', async () => {
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
        `rebase ${String(n)} not read`,
      );
      if (n < 3) {
        await sleep(200);
        expect(messagesOf('alert')).toHaveLength(0);
        expect(itemsOf('delivery-alert')).toHaveLength(0);
      }
    }
    await h.waitFor(() => messagesOf('alert').length === 1, 'the user was not told');
    await sleep(300);

    expect(messagesOf('alert')).toHaveLength(1);
    expect(messagesOf('alert')[0]?.text).toMatch(/recal/i);
    expect(itemsOf('delivery-alert')).toHaveLength(1);
    expect(h.deliveryOf(id).state).toBe('watching');
    expect(h.workspace().loops[0]?.round).toBe(1);
    expect(h.mergeCalls()).toHaveLength(0);
    expect(git(h.bare, 'rev-parse', `refs/heads/feat/a`)).toBe(h.deliveryOf(id).pushedHead);
  });
});

describe('a PR closed or merged by hand on the forge (sc.6, sc.7)', () => {
  it('Given a PR closed by hand, When PACT reads it, Then the request is closed and says so, nothing is merged and the agents stay', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head } = await watching();
    h.setChecks(head, h.RUNNING);

    h.patchPr(1, { state: 'CLOSED' });
    await h.until(id, ['closed-on-forge']);

    expect(messagesOf('alert')).toHaveLength(1);
    expect(messagesOf('alert')[0]?.text).toContain('fermée');
    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.closed).toEqual([]);
    expect(h.workspace().loops[0]?.state).toBe('accepted');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
  });

  it('Given a PR merged by hand, When PACT reads it, Then the loop is merged and the issue done, with no merge call of PACT', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { id, head, dev, tester } = await watching();
    h.setChecks(head, h.RUNNING);

    h.patchPr(1, { state: 'MERGED' });
    await h.until(id, ['merged']);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.workspace().loops[0]?.state).toBe('merged');
    expect(h.workspace().issues[0]?.state).toBe('done');
    expect(h.closed.map((c) => c.id).sort()).toEqual([dev.id, tester.id].sort());
  });
});
