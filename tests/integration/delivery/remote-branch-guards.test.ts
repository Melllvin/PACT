import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, gitEnv, type DeliveryHarness } from './delivery-harness';

// 008 FR-043 — the safety guards around the deletion of the remote branch, and what the user hears
// when the branch is kept for another reason than a moved head (R1). Same setup as remote-branch.test.ts.

let h: DeliveryHarness;
let traceFile: string;

beforeEach(async () => {
  const root = join(
    process.env.TMPDIR ?? '/tmp',
    `pact-remote-guards-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`,
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
const deletions = () =>
  readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter(
      (line) =>
        line.includes('built-in:') &&
        /\bgit\b.*\bpush\b/.test(line) &&
        /\s:refs\/heads\/\S+/.test(line),
    );

async function watching(suffix: string, number: number) {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  const done = await h.until(request.id, ['watching']);
  const branch = team.dev.branch;
  const head = h.prHead(number);
  return { ...team, id: done.id, branch, head };
}

describe('FR-043 — the branch that is the target or the default one is never deleted', () => {
  it.each([
    ['the target of the request', { target: 'main' }, 'main'],
    ['the default branch of the repository', { target: 'release' }, 'main'],
  ])(
    'Given a request whose branch is %s and whose PR is exactly on that head, When merged, Then the branch is kept and nothing is pushed',
    async (_what, patch, victim) => {
      const a = await watching('a', 1);
      const tip = git(h.bare, 'rev-parse', `refs/heads/${victim}`);
      await h.workspaces.update(h.workspaceId, (ws) => ({
        ...ws,
        deliveries: ws.deliveries.map((d) =>
          d.id === a.id
            ? { ...d, ...patch, branch: victim, pactCommits: [...d.pactCommits, tip] }
            : d,
        ),
      }));
      h.patchPr(1, { state: 'MERGED', headRefName: victim, headRefOid: tip });
      await h.until(a.id, ['merged']);
      await sleep(300);

      expect(h.remoteHead(victim)).toBe(tip);
      expect(deletions()).toEqual([]);
      expect(messagesOf('alert')).toEqual([]);
    },
  );
});

describe('FR-043 — the forge cannot be asked: nothing is deleted, nothing crashes', () => {
  it('Given gh failing when the merged PR is read for the branch, When PACT sees the merge, Then the delivery is merged and the branch stays', async () => {
    const a = await watching('a', 1);
    const isView = (args: string[]) => args[0] === 'pr' && args[1] === 'view';
    let seen = 0;
    const arm = (): void => {
      h.beforeGh(isView, () => {
        seen += 1;
        // 1: the watcher sees the merge · 2: the author check of the cleanup · 3: the branch.
        if (seen === 3) return Promise.reject(new Error('gh: network down'));
        arm();
        return Promise.resolve();
      });
    };
    arm();

    h.patchPr(1, { state: 'MERGED' });
    await h.until(a.id, ['merged']);
    await h.waitFor(() => seen >= 3, 'the third read of the PR never happened', SHORT);
    await sleep(300);

    expect(h.deliveryOf(a.id).state).toBe('merged');
    expect(h.remoteHead(a.branch)).toBe(a.head);
    expect(deletions()).toEqual([]);
  });
});

describe('FR-043 / R1 — the branch is kept for another reason than a moved head: the user hears it', () => {
  it('Given a remote that cannot be reached, When the PR is merged, Then the branch is kept and a delivery-alert says the remote is unreachable', async () => {
    const a = await watching('a', 1);
    git(h.repo, 'remote', 'set-url', 'origin', join(h.root, 'nowhere.git'));

    h.patchPr(1, { state: 'MERGED' });
    await h.until(a.id, ['merged']);
    await h.waitFor(() => messagesOf('alert').length > 0, 'no alert for the kept branch', SHORT);

    expect(h.remoteHead(a.branch)).toBe(a.head);
    expect(messagesOf('alert')).toHaveLength(1);
    expect(messagesOf('alert')[0]?.text).toContain('PR #1');
    expect(messagesOf('alert')[0]?.text).toContain(a.branch);
    expect(messagesOf('alert')[0]?.text).toContain('injoignable');
    expect(messagesOf('alert')[0]?.text).not.toContain('fatal');
    expect(itemsOf('delivery-alert')).toHaveLength(1);
    expect(h.deliveryOf(a.id).state).toBe('merged');
  });

  it('Given a remote that refuses the deletion (a hook), When the PR is merged, Then the branch is kept and a delivery-alert says the remote refused', async () => {
    const a = await watching('a', 1);
    const hook = join(h.bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
    chmodSync(hook, 0o755);

    h.patchPr(1, { state: 'MERGED' });
    await h.until(a.id, ['merged']);
    await h.waitFor(() => messagesOf('alert').length > 0, 'no alert for the kept branch', SHORT);

    expect(h.remoteHead(a.branch)).toBe(a.head);
    expect(messagesOf('alert')).toHaveLength(1);
    expect(messagesOf('alert')[0]?.text).toContain('PR #1');
    expect(messagesOf('alert')[0]?.text).toContain(a.branch);
    expect(messagesOf('alert')[0]?.text).toContain('refusé');
    expect(messagesOf('alert')[0]?.text).not.toContain('protected branch');
    expect(itemsOf('delivery-alert')).toHaveLength(1);
  });

  it('Given a branch already deleted on the remote, When the PR is merged, Then nothing is said', async () => {
    const a = await watching('a', 1);
    git(h.bare, 'update-ref', '-d', `refs/heads/${a.branch}`);

    h.patchPr(1, { state: 'MERGED' });
    await h.until(a.id, ['merged']);
    await sleep(500);

    expect(h.remoteHead(a.branch)).toBeNull();
    expect(messagesOf('alert')).toEqual([]);
    expect(itemsOf('delivery-alert')).toEqual([]);
  });
});
