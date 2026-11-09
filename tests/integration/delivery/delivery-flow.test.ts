import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFinalState, prBody } from '../../../src/shared/delivery';
import {
  createDeliveryHarness,
  git,
  short,
  tryGit,
  type DeliveryHarness,
} from './delivery-harness';

// 008 T013 — the run of a request that passed its barriers (US1 sc.5, 6, 8, 9; FR-004, FR-005,
// FR-006, FR-033; research R5, R7, R13): fetch, rebase, tests on R, push, PR. A repository, a bare
// remote, the contractual fake `gh`. Nothing real, and no `refs/pull/*` anywhere.
//
// RED until DeliveryService exists (T018). The API assumed is in delivery-harness.ts.

let h: DeliveryHarness;

beforeEach(async () => {
  h = await createDeliveryHarness();
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const prCreates = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');

describe('the steps, in order', () => {
  it('Given origin/main ahead, When PACT runs, Then fetch, rebase, tests on R, push and PR come in that order (sc.5)', async () => {
    const { dev } = await h.team('a');
    const frozen = git(dev.worktreePath, 'rev-parse', 'HEAD');
    const upstream = h.pushToOrigin('main', { 'docs/notes.md': 'upstream\n' });

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['watching']);

    const steps = h.timeline.filter((s) => !s.startsWith('gh:') || s === 'gh:pr create');
    expect(steps).toEqual(['fetchRefs', 'rebaseOnto', 'tests', 'pushBranch', 'gh:pr create']);

    // R replays F on origin/main: another commit, the same content on top of upstream.
    const rebased = h.remoteHead('feat/a') ?? '';
    expect(rebased).not.toBe('');
    expect(rebased).not.toBe(frozen);
    expect(git(h.repo, 'rev-parse', `${rebased}^`)).toBe(upstream);
    expect(git(h.repo, 'diff', '--stat', frozen, rebased, '--', 'src', 'tests')).toBe('');
    expect(done.frozenCommit).toBe(frozen);
    expect(done.verdictCommit).toBe(rebased);
    expect(done.pactCommits).toEqual(expect.arrayContaining([frozen, rebased]));
    expect(done.pushedHead).toBe(rebased);

    // The tests of PACT ran on R, in a place that is not the worktree of the dev.
    expect(h.testRuns).toHaveLength(1);
    expect(h.testRuns[0]?.head).toBe(rebased);
    expect(h.testRuns[0]?.cwd).not.toBe(dev.worktreePath);
    expect(h.testRuns[0]?.command).toBe('node check-tests.mjs');
  });

  it('Given a run, When it fetches, Then only the target and the branches of its requests are fetched, never a PR ref (FR-033)', async () => {
    const { dev } = await h.team('a');

    const delivery = await h.request(dev.id);
    await h.until(delivery.id, ['watching']);

    const [, branches] = h.gitCalls.fetchRefs.mock.calls[0] ?? [];
    expect(branches).toContain('main');
    for (const branch of branches ?? []) {
      expect(branch).not.toMatch(/pull|refs\//);
    }
    expect(h.refsOf(h.repo)).not.toContain('refs/pull');
    expect(h.refsOf(h.repo)).not.toContain('refs/remotes/origin/pull');
    expect(h.ghLog().flat().join(' ')).not.toContain('refs/pull');
  });

  it('Given a run, When the PR is opened, Then it carries the title and the body of the contract, in the target branch (FR-005)', async () => {
    const { dev, tester } = await h.team('a', { published: 12 });

    const delivery = await h.request(dev.id, {
      title: 'Connexion par e-mail',
      message: 'feat: connexion par e-mail',
    });
    const done = await h.until(delivery.id, ['watching']);

    const pr = Object.values(h.ghStateNow().prs)[0];
    expect(pr).toMatchObject({
      number: 1,
      title: 'Connexion par e-mail',
      baseRefName: 'main',
      headRefOid: done.pushedHead,
    });
    expect(pr?.body).toBe(
      prBody({
        issue: {
          id: '001a-a',
          remote: { number: 12, url: 'https://github.com/pact/test/issues/12' },
          text: '',
        },
        message: 'feat: connexion par e-mail',
        verdict: {
          result: 'accepted',
          commit: done.verdictCommit ?? '',
          tester: tester.id,
        },
      }),
    );
    expect(pr?.body).toContain('Closes #12');
    expect(done.pr).toMatchObject({ number: 1, expectedAuthor: 'pact-user' });
    expect(done.pr?.url).toContain('/pull/1');
    // The loop waits for the merge: neither closed nor done (FR-007).
    expect(h.workspace().loops[0]?.state).toBe('delivering');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
  });

  it('Given an issue that is not published, When the PR is opened, Then its body says the issue without a closing link (Q11)', async () => {
    const { dev } = await h.team('a', { published: null });

    const delivery = await h.request(dev.id);
    await h.until(delivery.id, ['watching']);

    const body = Object.values(h.ghStateNow().prs)[0]?.body ?? '';
    expect(body).toContain('001a-a');
    expect(body).not.toContain('Closes #');
  });

  it('Given a PR to open without a verdict, When PACT runs, Then the PR says so on its first line and no loop is needed (FR-001)', async () => {
    const dev = await h.addAgent('dev', { branch: 'feat/seul' });
    await h.commit(dev, { 'src/seul.ts': 'export const s = 1;\n' });

    const delivery = await h.request(dev.id, { unverified: true, by: 'user' });
    const done = await h.until(delivery.id, ['watching']);

    expect(done.unverified).toBe(true);
    expect(done.testAgentId).toBeNull();
    expect(done.verdictCommit).toBeNull();
    expect(done.requestedBy).toBe('user');
    expect(Object.values(h.ghStateNow().prs)[0]?.body.split('\n')[0]).toMatch(/sans verdict/);
  });
});

describe('the target branch', () => {
  it('Given an agent whose starting branch is explicit, When PACT runs, Then it fetches, rebases on and opens the PR against that branch (Q12)', async () => {
    h.pushToOrigin('release', { 'RELEASE.md': 'v1\n' });
    git(h.repo, 'branch', 'release', 'origin/release');
    const { dev } = await h.team('a', { base: 'release' });
    const tip = h.pushToOrigin('release', { 'RELEASE.md': 'v2\n' });

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['watching']);

    expect(done.target).toBe('release');
    expect(h.gitCalls.fetchRefs.mock.calls[0]?.[1]).toContain('release');
    expect(git(h.repo, 'rev-parse', `${h.remoteHead('feat/a') ?? ''}^`)).toBe(tip);
    expect(Object.values(h.ghStateNow().prs)[0]?.baseRefName).toBe('release');
    const create = prCreates()[0] ?? [];
    expect(create[create.indexOf('--base') + 1]).toBe('release');
  });

  it('Given an agent that started from the main branch, When PACT runs, Then the PR targets the main branch', async () => {
    const { dev } = await h.team('a');

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['watching']);

    expect(done.target).toBe('main');
    const create = prCreates()[0] ?? [];
    expect(create[create.indexOf('--base') + 1]).toBe('main');
    expect(create[create.indexOf('--head') + 1]).toBe('feat/a');
  });
});

describe('a run that fails', () => {
  it('Given red tests after the rebase, When PACT runs, Then nothing is pushed, a counted round opens and the dev is told (sc.6, FR-017)', async () => {
    const { lead, dev } = await h.team('a');
    // origin/main now holds a file that makes the tests red: R, the rebased commit, inherits it.
    h.pushToOrigin('main', { FAIL: 'rouge\n' });

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['tests-failed']);

    expect(isFinalState(done.state)).toBe(true);
    expect(h.remoteHead('feat/a')).toBeNull();
    expect(prCreates()).toEqual([]);
    const loop = h.workspace().loops[0];
    expect(loop?.state).toBe('running');
    expect(loop?.round).toBe(2);
    expect(loop?.rounds).toHaveLength(2);
    const toDev = h.messagesTo(dev.id).filter((m) => m.from === 'pact' && m.kind === 'verdict');
    expect(toDev.at(-1)?.text).toContain('tour 2');
    const told = h.deliveryMessages();
    expect(told.map((m) => m.delivery?.outcome)).toEqual(['tests-failed']);
    expect(told[0]).toMatchObject({ to: lead.id, about: dev.id });
    expect(told[0]?.text).toContain('Tests rouges sur');
    expect(told[0]?.text).toContain('001a-a : tour 2 ouvert');
  });

  it('Given a rebase that fails for another reason than a conflict, When PACT runs, Then nothing is pushed and the request ends with its reason (sc.6)', async () => {
    const { dev } = await h.team('a');
    h.gitCalls.rebaseOnto.mockRejectedValueOnce(new Error('fatal: impossible de rejouer'));

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, [
      'tests-failed',
      'conflicted',
      'refused',
      'dropped',
      'closed-on-forge',
    ]);

    expect(isFinalState(done.state)).toBe(true);
    expect(done.reason).toBeTruthy();
    expect(h.remoteHead('feat/a')).toBeNull();
    expect(prCreates()).toEqual([]);
    expect(h.testRuns).toHaveLength(0);
    expect(h.workspace().loops[0]?.round).toBe(2);
    expect(h.deliveryMessages()).toHaveLength(1);
  });

  it('Given a conflict at the rebase, When PACT runs, Then nothing is pushed, the round is counted and the dev is told to rebase itself (sc.9, FR-004)', async () => {
    const { lead, dev } = await h.team('a');
    h.pushToOrigin('main', { 'src/a.ts': 'export const a = "upstream";\n' });
    const before = git(dev.worktreePath, 'rev-parse', 'HEAD');

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['conflicted']);

    expect(done.reason).toContain('src/a.ts');
    expect(h.remoteHead('feat/a')).toBeNull();
    expect(prCreates()).toEqual([]);
    expect(h.testRuns).toHaveLength(0);
    // The worktree of the dev is as it was, and no temporary worktree is left behind.
    expect(git(dev.worktreePath, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(dev.worktreePath, 'status', '--porcelain')).toBe('');
    expect(git(h.repo, 'worktree', 'list')).not.toContain('deliveries');
    expect(tryGit(h.repo, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD')).toBeNull();
    // A counted round opens; the dev is told to rebase on origin/main and the files.
    const loop = h.workspace().loops[0];
    expect(loop?.state).toBe('running');
    expect(loop?.round).toBe(2);
    const toDev = h.messagesTo(dev.id).filter((m) => m.from === 'pact' && m.kind === 'verdict');
    expect(toDev.at(-1)?.text).toContain('origin/main');
    expect(toDev.at(-1)?.text).toContain('src/a.ts');
    const told = h.deliveryMessages();
    expect(told.map((m) => m.delivery?.outcome)).toEqual(['conflicted']);
    expect(told[0]).toMatchObject({ to: lead.id, about: dev.id });
    expect(told[0]?.text).toContain('Conflit au recalage · 001a-a · src/a.ts : tour 2 ouvert');
  });

  it('Given a loop at its ceiling, When red tests send the dev back, Then the loop escalates instead of opening a round (FR-018)', async () => {
    const { dev } = await h.team('a');
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      delivery: { ...ws.delivery, maxRounds: 1 },
    }));
    h.pushToOrigin('main', { FAIL: 'rouge\n' });

    const delivery = await h.request(dev.id);
    await h.until(delivery.id, ['tests-failed']);

    const loop = h.workspace().loops[0];
    expect(loop?.state).toBe('escalated');
    expect(loop?.rounds).toHaveLength(1);
  });
});

describe('the worktree of the dev after the push', () => {
  it('Given a dev that is clean, idle and still on F, When the PR is open, Then its worktree is brought to R', async () => {
    const { dev } = await h.team('a');
    h.pushToOrigin('main', { 'docs/notes.md': 'upstream\n' });

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['watching']);

    expect(git(dev.worktreePath, 'rev-parse', 'HEAD')).toBe(done.pushedHead);
    expect(git(dev.worktreePath, 'status', '--porcelain')).toBe('');
  });

  it('Given a dev that is working, When the PR is open, Then its worktree is not moved', async () => {
    const { dev } = await h.team('a');
    const frozen = git(dev.worktreePath, 'rev-parse', 'HEAD');
    h.pushToOrigin('main', { 'docs/notes.md': 'upstream\n' });
    const hold = h.holdTests();
    const delivery = await h.request(dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the tests of PACT never started');
    await h.setAgentState(dev, 'working');

    hold.release();
    const done = await h.until(delivery.id, ['watching']);

    expect(done.pushedHead).not.toBe(frozen);
    expect(git(dev.worktreePath, 'rev-parse', 'HEAD')).toBe(frozen);
  });

  it('Given a dev with changes that are not committed, When the PR is open, Then its worktree is not moved and the changes stay', async () => {
    const { dev } = await h.team('a');
    const frozen = git(dev.worktreePath, 'rev-parse', 'HEAD');
    h.pushToOrigin('main', { 'docs/notes.md': 'upstream\n' });
    const hold = h.holdTests();
    const delivery = await h.request(dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the tests of PACT never started');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(`${dev.worktreePath}/en-cours.ts`, 'export const wip = 1;\n'),
    );

    hold.release();
    await h.until(delivery.id, ['watching']);

    expect(git(dev.worktreePath, 'rev-parse', 'HEAD')).toBe(frozen);
    expect(git(dev.worktreePath, 'status', '--porcelain')).toContain('en-cours.ts');
  });
});

describe('what the orchestrator hears', () => {
  it('Given a PR opened, When the run ends, Then exactly one message of kind delivery says it (FR-006, SC-008)', async () => {
    const { lead, dev } = await h.team('a');

    const delivery = await h.request(dev.id);
    const done = await h.until(delivery.id, ['watching']);

    const told = h.deliveryMessages();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      from: 'pact',
      to: lead.id,
      about: dev.id,
      type: 'action',
      delivery: { id: delivery.id, outcome: 'pr-opened' },
    });
    expect(told[0]?.text).toBe(`PR #1 ouverte · 001a-a · ${short(done.pushedHead ?? '')}`);
    const pr = told[0]?.delivery?.pr;
    expect(typeof pr === 'object' ? pr.number : pr).toBe(1);
  });

  it('Given a PR opened, When the steps are over, Then the request was written more than once, not only at the end (R2)', async () => {
    const { dev } = await h.team('a');

    const delivery = await h.request(dev.id);
    await h.until(delivery.id, ['watching']);

    const saved = h.workspaces.get(h.workspaceId)?.deliveries;
    expect(saved?.[0]).toMatchObject({ id: delivery.id, state: 'watching' });
    expect(h.changes.length).toBeGreaterThan(1);
  });
});
