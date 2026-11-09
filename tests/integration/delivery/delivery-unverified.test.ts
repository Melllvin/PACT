import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, tryGit, type DeliveryHarness } from './delivery-harness';

// 008 T036 — User Story 3, the PR without a verdict (sc.7 to 11, FR-013, FR-039): Auto never merges
// it; Valider checks the CI, the author, the source repository and the head, with no verdict; a red
// CI, a conflict and a refusal are told with no counter; a new commit drops the request and the same
// gesture creates it again; after the merge no worktree is removed. The branch of the remote belongs
// to T067. A repository, a bare remote, the contractual fake `gh`, the real services; a CI is
// configured (a required check), the watcher reads every 50 ms.
//
// RED until T039 (`decide` on a PR of the forge). Same assumed API as delivery-review.test.ts. The
// « À faire » alert of a signalled outcome (`delivery-alert`) is a later task: here the outcome is
// read in the journal told to the orchestrator.

let h: DeliveryHarness;

beforeEach(async () => {
  h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const names = () => 'Fake';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messagesOf = (outcome: string) =>
  h.deliveryMessages().filter((m) => m.delivery?.outcome === outcome);
const prCreates = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');
const reviewItems = (): TodoItem[] =>
  deriveTodos(h.workspace(), names).filter((t) => t.kind === 'delivery-review');
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => false,
    () => true,
  );

/** The lone agent of the user: a commit, no loop, no tester. */
async function lone(suffix = 'u') {
  const lead = await h.addAgent('orchestrator', { branch: `lead/${suffix}` });
  const dev = await h.addAgent('dev', { branch: `feat/${suffix}` });
  await h.commit(dev, { [`src/${suffix}.ts`]: `export const ${suffix} = 1;\n` }, 'feat');
  return { lead, dev, branch: `feat/${suffix}` };
}

/** The PR is open and watched (the user's gesture « Créer la PR sans verdict »). */
async function watching(suffix = 'u') {
  const agent = await lone(suffix);
  const request = await h.request(agent.dev.id, { unverified: true, by: 'user' });
  const done = await h.until(request.id, ['watching']);
  return { ...agent, id: done.id, head: h.prHead(1) };
}

/** The same, with the CI green: the PR waits for a review. */
async function reviewing(suffix = 'u') {
  const base = await watching(suffix);
  h.setChecks(base.head, h.GREEN);
  await h.until(base.id, ['reviewing']);
  return base;
}

describe('sc.7 — Auto never merges a PR without a verdict', () => {
  it('Given Auto on and a CI green, When PACT reads the checks, Then it merges nothing and asks for the review, which says « sans verdict »', async () => {
    const base = await watching();
    await h.setSettings({ auto: true });

    h.setChecks(base.head, h.GREEN);
    await h.until(base.id, ['reviewing']);
    await sleep(300);

    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    await h.waitFor(() => messagesOf('review-requested').length > 0, 'no review was requested');
    expect(messagesOf('review-requested')).toHaveLength(1);
    const [item] = reviewItems();
    expect(item?.title).toContain('sans verdict');
    expect(item?.delivery).toMatchObject({ id: base.id, head: base.head });
  });

  it('Given a PR without a verdict waiting for a review, When Auto is turned on afterwards, Then it is still not merged', async () => {
    const base = await reviewing();

    await h.setSettings({ auto: true });
    await sleep(300);

    expect(h.mergeCalls()).toEqual([]);
    expect(h.deliveryOf(base.id).state).toBe('reviewing');
  });

  it('Given the review, When the user validates, Then the CI, the author, the source repository and the head are read again and that very head is merged, without a verdict', async () => {
    const base = await reviewing();
    const mark = h.ghLog().length;

    await h.delivery.decide({ deliveryId: base.id, decision: 'validate', head: base.head });
    await h.until(base.id, ['merged']);

    const calls = h.ghLog().slice(mark);
    const view = calls.findIndex(([a, b]) => a === 'pr' && b === 'view');
    const merge = calls.findIndex(([a, b]) => a === 'pr' && b === 'merge');
    expect(view).toBeGreaterThan(-1);
    expect(view).toBeLessThan(merge);
    expect(h.mergeCalls()).toEqual([
      ['pr', 'merge', '1', '--squash', '--match-head-commit', base.head],
    ]);
    expect(h.deliveryOf(base.id).verdictCommit).toBeNull();
    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head: base.head }]);
  });

  it('Given main moved since the request (a rebase without conflict), When the user validates the head shown, Then the rebased commit is the one merged', async () => {
    const agent = await lone('r');
    h.pushToOrigin('main', { 'CHANGELOG.md': '# changes\n' }, 'upstream');
    const request = await h.request(agent.dev.id, { unverified: true, by: 'user' });
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    expect(head).not.toBe(h.deliveryOf(request.id).frozenCommit);
    h.setChecks(head, h.GREEN);
    await h.until(request.id, ['reviewing']);

    await h.delivery.decide({ deliveryId: request.id, decision: 'validate', head });
    await h.until(request.id, ['merged']);

    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head }]);
  });

  it.each([
    ['the author changed', { author: { login: 'someone-else' } }],
    ['the source repository is a fork', { isCrossRepository: true }],
  ])(
    'Given %s, When the user validates, Then nothing is merged and the user is warned',
    async (_what, change) => {
      const base = await reviewing();
      h.patchPr(1, change);

      const refused = await rejected(
        h.delivery.decide({ deliveryId: base.id, decision: 'validate', head: base.head }),
      );
      await sleep(200);

      expect(refused || messagesOf('alert').length > 0).toBe(true);
      expect(h.mergeCalls()).toEqual([]);
      expect(h.prStateOnForge(1)).toBe('OPEN');
      expect(h.deliveryOf(base.id).state).not.toBe('merged');
    },
  );

  it('Given a head that PACT did not push, When the user validates, Then nothing is merged and the request falls', async () => {
    const base = await reviewing();
    h.pushToOrigin(base.branch, { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');

    await h.delivery
      .decide({ deliveryId: base.id, decision: 'validate', head: base.head })
      .catch(() => undefined);
    await h.until(base.id, ['dropped']);

    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(messagesOf('dropped')).toHaveLength(1);
  });

  it('Given a CI that is not green on the head, When the user validates, Then nothing is merged (the CI is checked, there is no verdict to lean on)', async () => {
    const base = await watching();
    h.setChecks(base.head, h.RUNNING);
    await sleep(200);

    const refused = await rejected(
      h.delivery.decide({ deliveryId: base.id, decision: 'validate', head: base.head }),
    );
    await sleep(200);

    expect(refused).toBe(true);
    expect(h.mergeCalls()).toEqual([]);
  });
});

describe('sc.8 — a red CI is told, with no round counted', () => {
  it('Given a PR without a verdict, When its CI turns red, Then the orchestrator is told which check, nobody is sent back to work and no round is counted', async () => {
    const base = await watching();

    h.setChecks(base.head, [{ id: 11, name: 'ci', status: 'completed', conclusion: 'failure' }]);
    await h.until(base.id, ['ci-red']);

    expect(messagesOf('ci-red')).toHaveLength(1);
    expect(messagesOf('ci-red')[0]?.text).toContain('ci');
    expect(h.messagesTo(base.dev.id).filter((m) => m.kind === 'verdict')).toEqual([]);
    expect(h.workspace().loops).toEqual([]);
    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(reviewItems()).toEqual([]);
  });
});

describe('sc.9 — a conflict or a refusal is told, with no counter', () => {
  it('Given a PR without a verdict, When the rebase on main conflicts, Then the request ends in conflicted and is told, and nobody is sent a round', async () => {
    const agent = await lone('c');
    await h.commit(agent.dev, { 'shared.txt': 'dev\n' }, 'dev edits shared');
    h.pushToOrigin('main', { 'shared.txt': 'upstream\n' }, 'upstream edits shared');

    const request = await h.request(agent.dev.id, { unverified: true, by: 'user' });
    await h.until(request.id, ['conflicted']);

    expect(messagesOf('conflicted')).toHaveLength(1);
    expect(h.messagesTo(agent.dev.id).filter((m) => m.kind === 'verdict')).toEqual([]);
    expect(h.workspace().loops).toEqual([]);
    expect(prCreates()).toEqual([]);
  });

  it('Given the review, When the user refuses with a reason, Then the request ends in user-refused and is told, the PR stays open and no round is counted', async () => {
    const base = await reviewing();

    await h.delivery.decide({
      deliveryId: base.id,
      decision: 'refuse',
      head: base.head,
      reason: 'Pas de tests.',
    });

    expect(h.deliveryOf(base.id).state).toBe('user-refused');
    expect(h.deliveryOf(base.id).reason).toContain('Pas de tests.');
    expect(messagesOf('user-refused')).toHaveLength(1);
    expect(h.workspace().loops).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.mergeCalls()).toEqual([]);
    expect(reviewItems()).toEqual([]);
  });

  it('Given the review, When the user refuses without a reason, Then it is rejected', async () => {
    const base = await reviewing();

    const refused = await rejected(
      h.delivery.decide({ deliveryId: base.id, decision: 'refuse', head: base.head, reason: ' ' }),
    );

    expect(refused).toBe(true);
    expect(h.deliveryOf(base.id).state).toBe('reviewing');
  });
});

describe('sc.10 — a new commit drops the request, the same gesture creates it again', () => {
  it('Given a PR without a verdict and a commit that PACT did not make on its branch, When PACT reads it, Then the request falls and the PR is kept', async () => {
    const base = await watching();
    h.pushToOrigin(base.branch, { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');

    await h.until(base.id, ['dropped']);

    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.deliveryOf(base.id).pr?.number).toBe(1);
    expect(h.mergeCalls()).toEqual([]);
    expect(messagesOf('dropped')).toHaveLength(1);
  });

  it('Given that fall, When the user makes the same gesture again, Then the PR is resumed by its number (no second PR) and watched anew', async () => {
    const base = await watching();
    const pushed = h.remoteHead(base.branch) ?? '';
    h.pushToOrigin(base.branch, { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');
    await h.until(base.id, ['dropped']);
    git(h.bare, 'update-ref', `refs/heads/${base.branch}`, pushed);
    git(h.repo, 'fetch', '-q', 'origin');
    await h.commit(base.dev, { 'src/encore.ts': 'export const e = 1;\n' }, 'encore');

    const again = await h.request(base.dev.id, { unverified: true, by: 'user' });
    await h.until(again.id, ['watching']);

    expect(prCreates()).toHaveLength(1);
    expect(h.deliveryOf(again.id).pr?.number).toBe(1);
    expect(h.deliveryOf(again.id).unverified).toBe(true);
    expect(h.prHead(1)).toBe(h.deliveryOf(again.id).pushedHead);
    h.setChecks(h.prHead(1), h.GREEN);
    await h.until(again.id, ['reviewing']);
    expect(reviewItems()).toHaveLength(1);
  });
});

describe('sc.11 — after the merge, no worktree is removed', () => {
  it('Given a PR without a verdict that is merged, When PACT sees it, Then the loop is untouched, no agent is closed and the worktree and the branch of the dev are still there', async () => {
    const base = await reviewing();

    await h.delivery.decide({ deliveryId: base.id, decision: 'validate', head: base.head });
    await h.until(base.id, ['merged']);
    await sleep(200);

    expect(h.closed).toEqual([]);
    expect(existsSync(base.dev.worktreePath)).toBe(true);
    expect(
      tryGit(h.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${base.branch}`),
    ).not.toBeNull();
    // git writes `C:/…` on Windows: compare the worktrees it lists as paths, not as text.
    const listed = git(h.repo, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => resolve(line.slice('worktree '.length).trim()));
    expect(listed).toContain(resolve(base.dev.worktreePath));
    expect(messagesOf('merged')).toHaveLength(1);
  });
});
