import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, gitEnv, type DeliveryHarness } from './delivery-harness';

// 008 T067 — Phase 11, the remote branch (FR-043, US8 sc.12, US3 sc.11, research R18, contracts/gh.md):
// when the merge is seen, PACT deletes the remote branch of the followed PR if its head is still the
// merged commit, with ONE atomic push that carries its own lease
// (`git push origin --force-with-lease=refs/heads/<b>:<merged head> :refs/heads/<b>`); otherwise the
// branch stays and a `delivery-alert` says so. Never the default branch, never a branch PACT did not
// create, never a `git push --force` without a lease, nothing for the PR of someone else.
//
// What PACT ran is read from `GIT_TRACE` (every `git` of the services goes through `gitEnv`): the
// words of the push are the contract, not a private call. A repository, a bare `origin` on disk, the
// contractual fake `gh`, the real services; no network.
//
// RED until T068 (`GitService.deleteRemoteBranch` called from `onMerged`). The tests that expect
// « nothing » start with a control (an own PR whose branch IS deleted), so that each one fails now
// for the right reason: the missing deletion, never an accident of the setup.

let h: DeliveryHarness;
let traceFile: string;

beforeEach(async () => {
  const root = join(
    process.env.TMPDIR ?? '/tmp',
    `pact-remote-branch-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
  );
  traceFile = `${root}.trace`;
  writeFileSync(traceFile, '');
  (gitEnv as Record<string, string | undefined>).GIT_TRACE = traceFile;
  h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
}, 30_000);

afterEach(async () => {
  delete (gitEnv as Record<string, string | undefined>).GIT_TRACE;
  await h.dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SHORT = 5_000;
const messagesOf = (outcome: string) =>
  h.deliveryMessages().filter((m) => m.delivery?.outcome === outcome);
const itemsOf = (kind: string): TodoItem[] =>
  deriveTodos(h.workspace(), () => 'Fake').filter((t) => (t.kind as string) === kind);

/** Every `git push` the run made (built-in command lines of the trace). */
const pushes = (): string[] =>
  readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('built-in:') && /\bgit\b.*\bpush\b/.test(line));
/** The pushes that delete a branch of the remote: a refspec `:refs/heads/<b>`. */
const deletions = () => pushes().filter((line) => /\s:refs\/heads\/\S+/.test(line));
const leaseOf = (line: string) => {
  const found = /--force-with-lease=refs\/heads\/(\S+?):([0-9a-f]{40})/.exec(line);
  return found ? { branch: found[1] ?? '', sha: found[2] ?? '' } : null;
};
/** A push that forces with no lease: `--force`, `-f`, `+<refspec>` or an empty `--force-with-lease`. */
const bareForces = () =>
  pushes().filter(
    (line) =>
      /\s--force(\s|$)/.test(line) ||
      /\s-f(\s|$)/.test(line) ||
      /\s\+\S*refs\/heads\//.test(line) ||
      /--force-with-lease(\s|$)/.test(line),
  );

/** A dev accepted, delivered and watched: the PR is #`number`, on the commit PACT pushed. */
async function watching(suffix: string, number: number) {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  const done = await h.until(request.id, ['watching']);
  const branch = team.dev.branch;
  const head = h.prHead(number);
  expect(h.remoteHead(branch)).toBe(head);
  return { ...team, id: done.id, branch, head };
}

/** The forge says « merged » on PR `number` (squash on the forge side: the branch is left as it was). */
const mergedOnForge = (number: number, extra: Record<string, unknown> = {}) => { h.patchPr(number, { state: 'MERGED', ...extra }); };

const gone = (branch: string) =>
  h.waitFor(() => h.remoteHead(branch) === null, `${branch} stayed`, SHORT);

describe('FR-043 — the head is still the merged commit: the branch is deleted, by a lease', () => {
  it('Given Auto on and a PR that PACT merges, When the merge is done, Then the remote branch is deleted by one push whose lease is the merged head', async () => {
    const a = await watching('a', 1);
    await h.setSettings({ auto: true });

    h.setChecks(a.head, h.GREEN);
    await h.until(a.id, ['merged']);
    await gone(a.branch);

    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head: a.head }]);
    const lines = deletions();
    expect(lines).toHaveLength(1);
    expect(leaseOf(lines[0] ?? '')).toEqual({ branch: a.branch, sha: a.head });
    expect(lines[0]).toContain(`:refs/heads/${a.branch}`);
    expect(bareForces()).toEqual([]);
    expect(messagesOf('alert')).toEqual([]);
    expect(itemsOf('delivery-alert')).toEqual([]);
  });

  it('Given a PR merged on the forge by someone, When PACT sees it, Then the same rule applies: deleted by a lease on the merged head', async () => {
    const a = await watching('a', 1);

    mergedOnForge(1);
    await h.until(a.id, ['merged']);
    await gone(a.branch);

    const lines = deletions();
    expect(lines).toHaveLength(1);
    expect(leaseOf(lines[0] ?? '')).toEqual({ branch: a.branch, sha: a.head });
    expect(bareForces()).toEqual([]);
  });

  it('Given only the branch of the PR, When it is deleted, Then main and the other branches of the remote are untouched', async () => {
    const a = await watching('a', 1);
    const other = h.pushToOrigin('colleague/work', { 'other.txt': 'x\n' }, 'colleague');
    const mainBefore = git(h.bare, 'rev-parse', 'refs/heads/main');

    mergedOnForge(1);
    await h.until(a.id, ['merged']);
    await gone(a.branch);

    expect(h.remoteHead('colleague/work')).toBe(other);
    expect(git(h.bare, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
    expect(deletions()).toHaveLength(1);
  });
});

describe('FR-043 — the head changed: the branch stays and PACT says so', () => {
  it('Given a commit pushed to the branch after the head that was merged, When PACT sees the merge, Then the branch is kept, nothing is forced, and a delivery-alert tells the user', async () => {
    const a = await watching('a', 1);
    h.patchPr(1, { frozenHead: true });
    const later = h.pushToOrigin(a.branch, { 'src/apres.ts': 'export const a = 1;\n' }, 'apres');
    expect(later).not.toBe(a.head);

    mergedOnForge(1);
    await h.until(a.id, ['merged']);
    await h.waitFor(() => messagesOf('alert').length > 0, 'no alert for the kept branch', SHORT);

    expect(h.remoteHead(a.branch)).toBe(later);
    // The lease was tried on the merged head and refused; or not tried at all: never forced.
    for (const line of deletions()) expect(leaseOf(line)?.sha).toBe(a.head);
    expect(bareForces()).toEqual([]);
    expect(messagesOf('alert')).toHaveLength(1);
    expect(messagesOf('alert')[0]?.text).toContain('PR #1');
    expect(messagesOf('alert')[0]?.text).toContain(a.branch);
    expect(itemsOf('delivery-alert')).toHaveLength(1);
    expect(h.deliveryOf(a.id).state).toBe('merged');
  });
});

describe('FR-043 — the PR of someone else: nothing', () => {
  it('Given a PR merged whose author is not the expected one, When PACT sees it, Then its branch is not deleted (while the own PR of the same project is)', async () => {
    const a = await watching('a', 1);
    const b = await watching('b', 2);

    mergedOnForge(2, { author: { login: 'someone-else' } });
    mergedOnForge(1);
    await h.until(a.id, ['merged']);
    await h.until(b.id, ['merged']);
    await gone(a.branch); // control: the own PR is cleaned
    await sleep(300);

    expect(h.remoteHead(b.branch)).toBe(b.head);
    expect(deletions().map((line) => leaseOf(line)?.branch)).toEqual([a.branch]);
    expect(bareForces()).toEqual([]);
  });
});

describe('FR-043 — never the default branch, never a branch PACT did not create', () => {
  it.each([
    ['the default branch', 'main'],
    ['a branch of a colleague', 'colleague/work'],
  ])(
    'Given a followed PR whose head branch is %s and whose head is exactly the merged one (the lease would succeed), When it is merged, Then that branch is kept',
    async (_what, victim) => {
      const a = await watching('a', 1);
      const b = await watching('b', 2);
      if (victim !== 'main') h.pushToOrigin(victim, { 'other.txt': 'x\n' }, 'colleague');
      const tip = git(h.bare, 'rev-parse', `refs/heads/${victim}`);

      mergedOnForge(1);
      mergedOnForge(2, { headRefName: victim, headRefOid: tip });
      await h.until(a.id, ['merged']);
      await h.until(b.id, ['merged']);
      await gone(a.branch); // control: the branch PACT created is deleted
      await sleep(300);

      expect(h.remoteHead(victim)).toBe(tip);
      expect(deletions().map((line) => leaseOf(line)?.branch)).toEqual([a.branch]);
      expect(bareForces()).toEqual([]);
    },
  );

  it('Given the whole delivery, When PACT deletes the branch, Then the lease is the only way it forces: no push of the run forces without one', async () => {
    const a = await watching('a', 1);

    mergedOnForge(1);
    await h.until(a.id, ['merged']);
    await gone(a.branch);

    expect(deletions()).not.toHaveLength(0);
    for (const line of deletions())
      expect(line).toMatch(/--force-with-lease=refs\/heads\/\S+:[0-9a-f]{40}/);
    expect(bareForces()).toEqual([]);
  });
});

describe('US3 sc.11 — a PR without a verdict that is merged: the same rule', () => {
  async function reviewing(suffix: string) {
    const agent = await h.addAgent('orchestrator', { branch: `lead/${suffix}` });
    const dev = await h.addAgent('dev', { branch: `feat/${suffix}` });
    await h.commit(dev, { [`src/${suffix}.ts`]: `export const ${suffix} = 1;\n` }, 'feat');
    const request = await h.request(dev.id, { unverified: true, by: 'user' });
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(request.id, ['reviewing']);
    return { agent, dev, id: request.id, head, branch: `feat/${suffix}` };
  }

  it('Given a PR without a verdict that the user validates, When it is merged, Then its remote branch is deleted by a lease on the merged head, and the worktree stays', async () => {
    const u = await reviewing('u');

    await h.delivery.decide({ deliveryId: u.id, decision: 'validate', head: u.head });
    await h.until(u.id, ['merged']);
    await gone(u.branch);

    const lines = deletions();
    expect(lines).toHaveLength(1);
    expect(leaseOf(lines[0] ?? '')).toEqual({ branch: u.branch, sha: u.head });
    expect(bareForces()).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(git(u.dev.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(u.branch);
  });

  it('Given a PR without a verdict merged on the forge, with a commit pushed after its head, When PACT sees it, Then the branch is kept and a delivery-alert says so', async () => {
    const u = await reviewing('u');
    h.patchPr(1, { frozenHead: true });
    const later = h.pushToOrigin(u.branch, { 'src/apres.ts': 'export const a = 1;\n' }, 'apres');

    mergedOnForge(1);
    await h.until(u.id, ['merged']);
    await h.waitFor(() => messagesOf('alert').length > 0, 'no alert for the kept branch', SHORT);

    expect(h.remoteHead(u.branch)).toBe(later);
    expect(bareForces()).toEqual([]);
    expect(itemsOf('delivery-alert')).toHaveLength(1);
  });
});
