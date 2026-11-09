import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, git, type DeliveryHarness } from './delivery-harness';

// 008 T025 — the merge of a followed PR (US2 sc.1, 2, 3, 7, 8; FR-009 to FR-011, FR-031; the refusal
// of the protection; Auto turned off during a merge, edge cases). A repository, a bare remote, the
// contractual fake `gh` over a JSON file, the real services around. Nothing real, no `--auto`, no
// `refs/pull/*`. The CI is driven by the test through the checks of the fake `gh` (`setChecks`); the
// watcher reads every 50 ms here (`pollMs`).
//
// RED until the CI watcher and the merge exist (T028, T029). The API assumed is in delivery-harness.ts:
// `agents.close`, `pollMs` and `settingsChanged` of DeliveryService, with the states `merging`,
// `merged`, `merge-failed`, `dropped`, `reviewing` of data-model.md, and the outcomes `merged`,
// `merge-failed`, `alert`, `dropped` of the journal (contracts/mcp-tools.md).

let h: DeliveryHarness;

beforeEach(async () => {
  // A CI is configured (a required check): no check read means « pending », never « green ».
  h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

/** A dev accepted, delivered and watched: the PR is #1, on the commit PACT pushed. */
async function watching(suffix = 'a') {
  const team = await h.team(suffix);
  const delivery = await h.request(team.dev.id);
  const done = await h.until(delivery.id, ['watching']);
  return { ...team, delivery: done, head: h.prHead(1), branch: `feat/${suffix}` };
}

const outcomes = () => h.deliveryMessages().map((m) => m.delivery?.outcome);
const messagesOf = (outcome: string) =>
  h.deliveryMessages().filter((m) => m.delivery?.outcome === outcome);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkRunReads = () =>
  h.ghLog().filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;

describe('the merge of the head, in the mode of the project (sc.1, FR-009, FR-010)', () => {
  it.each(['squash', 'merge', 'rebase'] as const)(
    'Given Auto on, a verdict accepted and every check green on the head, When PACT reads the checks, Then it merges that commit in mode %s, with --match-head-commit and without --auto',
    async (mode) => {
      const { head } = await watching();
      const mainBefore = git(h.bare, 'rev-parse', 'refs/heads/main');
      await h.setSettings({ auto: true, mergeMode: mode });

      h.setChecks(head, h.GREEN);
      const done = await h.until(h.deliveries()[0]?.id ?? '', ['merged']);

      expect(h.mergeCalls()).toEqual([
        ['pr', 'merge', '1', `--${mode}`, '--match-head-commit', head],
      ]);
      expect(h.ghLog().flat().join(' ')).not.toContain('--auto');
      expect(h.ghLog().flat().join(' ')).not.toContain('refs/pull');
      expect(h.merges()).toEqual([{ number: 1, mode, head }]);
      expect(git(h.bare, 'rev-parse', 'refs/heads/main')).not.toBe(mainBefore);
      expect(done.state).toBe('merged');
      expect(messagesOf('merged')).toHaveLength(1);
    },
  );

  it('Given Auto on and a check that fails, When PACT reads it, Then nothing is merged and the round goes back to the dev', async () => {
    const { head, dev } = await watching();
    await h.setSettings({ auto: true });

    h.setChecks(head, [{ id: 11, name: 'ci', status: 'completed', conclusion: 'failure' }]);
    await h.until(h.deliveries()[0]?.id ?? '', ['ci-red']);
    await sleep(300);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.messagesTo(dev.id).some((m) => m.text.includes('ci'))).toBe(true);
  });

  it('Given Auto on and checks still running, When PACT reads them again and again, Then it does not merge', async () => {
    const { head } = await watching();
    await h.setSettings({ auto: true });

    h.setChecks(head, h.RUNNING);
    const before = checkRunReads();
    await h.waitFor(() => checkRunReads() >= before + 3, 'the checks were not read three times');

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.deliveries()[0]?.state).toBe('watching');
  });
});

describe('a head that PACT did not make (sc.2)', () => {
  it('Given checks green on the commit of PACT and a PR whose head was pushed by someone else, When PACT reads, Then it does not merge and the request is dropped', async () => {
    const { head, branch } = await watching();
    await h.setSettings({ auto: true });
    h.pushToOrigin(branch, { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');

    h.setChecks(head, h.GREEN); // green on the old head only
    await h.until(h.deliveries()[0]?.id ?? '', ['dropped']);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(outcomes()).toContain('dropped');
  });
});

describe('a commit pushed between the read and the merge (sc.3)', () => {
  it('Given green checks, When a commit is pushed to the PR just before the merge, Then the merge fails with no effect, and PACT says so', async () => {
    const { head, branch } = await watching();
    const mainBefore = git(h.bare, 'rev-parse', 'refs/heads/main');
    await h.setSettings({ auto: true });
    h.beforeGh(
      ([a, b]) => a === 'pr' && b === 'merge',
      () => {
        h.pushToOrigin(branch, { 'src/tard.ts': 'export const t = 1;\n' }, 'tard');
        return Promise.resolve();
      },
    );

    h.setChecks(head, h.GREEN);
    await h.waitFor(() => messagesOf('merge-failed').length > 0, 'the failed merge was not told');

    const [call] = h.mergeCalls();
    expect(call).toEqual(['pr', 'merge', '1', '--squash', '--match-head-commit', head]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.merges()).toEqual([]);
    expect(git(h.bare, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
    // Nothing is closed and the issue is not done: the work is not on main.
    expect(h.workspace().loops[0]?.state).toBe('delivering');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
    expect(h.closed).toEqual([]);
    expect(messagesOf('merge-failed')[0]?.text).toContain('Head branch was modified');
  });
});

describe('the loop, the issue and the agents close after the merge, not before (sc.7)', () => {
  it('Given a PR whose checks run, When it is merged on the forge, Then the loop is merged, the issue done and the dev and the tester closed, and none of it before', async () => {
    const { head, dev, tester, lead } = await watching();
    await h.setSettings({ auto: true });

    // Before: the PR is watched, the checks run.
    h.setChecks(head, h.RUNNING);
    const before = checkRunReads();
    await h.waitFor(() => checkRunReads() >= before + 3, 'the checks were not read three times');
    expect(h.workspace().loops[0]?.state).toBe('delivering');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
    expect(h.closed).toEqual([]);

    h.setChecks(head, h.GREEN);
    await h.until(h.deliveries()[0]?.id ?? '', ['merged']);

    expect(h.workspace().loops[0]?.state).toBe('merged');
    expect(h.workspace().issues[0]?.state).toBe('done');
    expect(h.closed.map((c) => c.id).sort()).toEqual([dev.id, tester.id].sort());
    expect(h.closed.map((c) => c.id)).not.toContain(lead.id);
    for (const closed of h.closed) {
      // Closed once the forge says « merged », and nothing removed: the cleanup has its own rules.
      expect(closed.prState).toBe('MERGED');
      expect(closed.removeWorktree).toBe(false);
    }
    expect(messagesOf('merged')[0]?.delivery?.pr).toMatchObject({ number: 1 });
    expect(messagesOf('merged')[0]?.to).toBe(lead.id);
  });
});

describe('a PR green and waiting for a review when Auto is turned on (sc.8, FR-011)', () => {
  it('Given a green PR waiting for the user because Auto was off, When Auto is turned on, Then PACT merges it', async () => {
    const { head } = await watching();
    h.setChecks(head, h.GREEN);
    const id = h.deliveries()[0]?.id ?? '';
    await h.until(id, ['reviewing']);
    await sleep(300);
    expect(h.mergeCalls()).toHaveLength(0);

    await h.setSettings({ auto: true });
    await h.until(id, ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
  });

  it('Given a PR whose CI is running with Auto off, When Auto is turned on and the CI then turns green, Then PACT merges it (sc.5)', async () => {
    const { head } = await watching();
    h.setChecks(head, h.RUNNING);
    const before = checkRunReads();
    await h.waitFor(() => checkRunReads() >= before + 2, 'the checks were not read twice');

    await h.setSettings({ auto: true });
    h.setChecks(head, h.GREEN);
    await h.until(h.deliveries()[0]?.id ?? '', ['merged']);

    expect(h.mergeCalls()).toHaveLength(1);
  });

  it('Given a PR whose CI is running with Auto on, When Auto is turned off and the CI then turns green, Then PACT does not merge and asks for a review (sc.6)', async () => {
    const { head } = await watching();
    await h.setSettings({ auto: true });
    h.setChecks(head, h.RUNNING);
    const before = checkRunReads();
    await h.waitFor(() => checkRunReads() >= before + 2, 'the checks were not read twice');

    await h.setSettings({ auto: false });
    h.setChecks(head, h.GREEN);
    await h.until(h.deliveries()[0]?.id ?? '', ['reviewing']);
    await sleep(300);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.deliveries()[0]?.state).toBe('reviewing');
  });
});

describe('what is read again just before the merge (FR-031)', () => {
  it.each([
    [
      'the author of the PR',
      () => {
        h.patchPr(1, { author: { login: 'someone-else' } });
      },
    ],
    [
      'the repository of origin of the PR (a fork)',
      () => {
        h.patchPr(1, { isCrossRepository: true });
      },
    ],
    [
      'the login of gh (another account)',
      () => {
        h.setGhState({ login: 'another-account' });
      },
    ],
  ])(
    'Given Auto on and green checks, When %s is not the expected one, Then PACT does not merge and alerts',
    async (_what, change) => {
      const { head } = await watching();
      await h.setSettings({ auto: true });
      change();

      h.setChecks(head, h.GREEN);
      await h.waitFor(() => messagesOf('alert').length > 0, 'no alert was told');
      await sleep(300);

      expect(h.mergeCalls()).toHaveLength(0);
      expect(h.prStateOnForge(1)).toBe('OPEN');
      expect(h.deliveries()[0]?.state).not.toBe('merged');
      expect(h.closed).toEqual([]);
    },
  );

  it('Given green checks, When the head of the PR changes after the checks were read and before the merge, Then PACT does not merge', async () => {
    const { head, branch } = await watching();
    await h.setSettings({ auto: true });
    // The first view of the PR after the green checks were read: the head moves under PACT’s feet,
    // so that only the reading just before the merge (FR-031) can see it.
    const readsBefore = checkRunReads();
    h.beforeGh(
      ([a, b]) => a === 'pr' && b === 'view' && checkRunReads() > readsBefore,
      () => {
        h.pushToOrigin(branch, { 'src/glisse.ts': 'export const g = 1;\n' }, 'glisse');
        return Promise.resolve();
      },
    );

    h.setChecks(head, h.GREEN);
    await h.waitFor(
      () => messagesOf('dropped').length + messagesOf('alert').length > 0,
      'neither a drop nor an alert was told',
    );
    await sleep(300);

    expect(h.mergeCalls()).toHaveLength(0);
    expect(h.prStateOnForge(1)).toBe('OPEN');
  });
});

describe('a merge that the protection of the branch refuses', () => {
  it('Given Auto on and green checks, When the forge refuses the merge, Then PACT tells the reason of the forge, tries no other mode and keeps the PR followed', async () => {
    const { head } = await watching();
    const refusal = 'Pull request #1 is not mergeable: the base branch policy prohibits the merge.';
    h.setGhState({ mergeRefusal: refusal });
    await h.setSettings({ auto: true, mergeMode: 'squash' });

    h.setChecks(head, h.GREEN);
    await h.waitFor(() => messagesOf('merge-failed').length > 0, 'the refusal was not told');
    // Several more reads: PACT neither retries in a loop, nor tells it twice.
    await sleep(400);

    expect(messagesOf('merge-failed')).toHaveLength(1);
    expect(messagesOf('merge-failed')[0]?.text).toContain('base branch policy');
    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
    expect(h.workspace().delivery.mergeMode).toBe('squash');
    expect(h.deliveries()[0]?.state).toBe('merge-failed');
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.workspace().loops[0]?.state).toBe('delivering');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
    expect(h.closed).toEqual([]);
  });
});

describe('Auto turned off while a merge is under way (edge case)', () => {
  it('Given a merge that left, When Auto is turned off before it ends, Then it is not cancelled: the PR is merged and the agents close', async () => {
    const { head, dev, tester } = await watching();
    await h.setSettings({ auto: true });
    const held = h.holdGh(([a, b]) => a === 'pr' && b === 'merge');

    h.setChecks(head, h.GREEN);
    await held.reached;
    // The state is written before the call (R2): a restart finds a merge under way.
    expect(h.deliveries()[0]?.state).toBe('merging');

    await h.setSettings({ auto: false });
    // The reads go on while the merge is held: no second merge leaves.
    await sleep(300);
    expect(h.timeline.filter((step) => step === 'gh:pr merge')).toHaveLength(1);

    held.release();
    await h.until(h.deliveries()[0]?.id ?? '', ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
    expect(h.workspace().delivery.auto).toBe(false);
    expect(h.closed.map((c) => c.id).sort()).toEqual([dev.id, tester.id].sort());
  });
});
