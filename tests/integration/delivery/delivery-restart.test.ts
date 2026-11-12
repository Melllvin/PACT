import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, git, type DeliveryHarness } from './delivery-harness';

// 008 T046 — US6 sc.1, SC-005, FR-025: PACT stops and starts again at any step of a delivery, and
// no PR and no merge is made twice. A repository, a bare remote, the contractual fake `gh` over a
// JSON file, the real services around. « The restart » is `h.restart({ restore: false })`: new
// `DeliveryService` and new `IntegrationService` on the same disk, then `resume()` as the app does at
// its start — `IntegrationService.restore()` (T051) is left out here, so that only the resume of the
// deliveries decides these tests; it has its own in integration-restore.test.ts. What the old service was doing is frozen where it was (a held call of git or of `gh`, never
// released): that is the state a crash leaves, written BEFORE the effect (research R2).
//
// What is RED, and why (the resume of `DeliveryService` knows `merging` and `watching`, not the rest):
//   - `pushing` and `opening` (4 tests): nothing takes the request up again, it stays `pushing` /
//     `opening` for ever and no PR is ever made.
// What is GREEN already (kept as the guard of SC-005): `watching` and `merging` (resume() exists since
// phase 4): no second PR, no second merge.
//
// ASSUMED API, not fixed by the contracts (listed in the report): after `resume()`, a request found in
// `pushing` or `opening` goes on to `watching` by itself; `pushing` pushes again without duplicating
// anything (the remote head is read before), `opening` reads the number of the PR NOTED in the request
// and creates one only when none is noted (FR-030: never a search by branch name).

let h: DeliveryHarness;

beforeEach(async () => {
  // A CI is configured (a required check): no check read means « pending », never « green ».
  h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const STEP_MS = 8_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const createCalls = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');
const isCreate = (args: string[]) => args[0] === 'pr' && args[1] === 'create';
const isMerge = (args: string[]) => args[0] === 'pr' && args[1] === 'merge';

/** Rewrites the saved state of a request, as a crash between two writes leaves it. */
async function rewrite(id: string, change: Record<string, unknown>) {
  await h.workspaces.update(h.workspaceId, (ws) => ({
    ...ws,
    deliveries: ws.deliveries.map((d) => (d.id === id ? { ...d, ...change } : d)),
  }));
}

describe('Given PACT stopped while the branch was being pushed (sc.1, SC-005)', () => {
  it('When PACT starts again, Then the push is made, one PR is opened and followed, and nothing is doubled', async () => {
    const { dev } = await h.team('a');
    // The push never leaves: the state `pushing` is saved, the remote has no branch.
    h.gitCalls.pushBranch.mockImplementationOnce(() => new Promise(() => undefined));
    const request = await h.request(dev.id);
    await h.until(request.id, ['pushing']);
    expect(h.remoteHead('feat/a')).toBeNull();
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(h.remoteHead('feat/a')).toBe(head);
    expect(h.prHead(1)).toBe(head);
    expect(createCalls()).toHaveLength(1);
    expect(h.deliveries()).toHaveLength(1);
  });

  it('When the push had gone through but `opening` was not saved, Then it is not an error: the same commit is pushed again, one PR is opened', async () => {
    const { dev } = await h.team('a');
    // The PR creation is held: the branch is pushed, `opening` is saved, no PR exists.
    const held = h.holdGh(isCreate);
    const request = await h.request(dev.id);
    await held.reached;
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');
    expect(h.remoteHead('feat/a')).toBe(head);
    // The crash came before the write of `opening`: the saved state says `pushing`, nothing noted.
    await rewrite(request.id, { state: 'pushing', pushedHead: null, pr: null });

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(h.remoteHead('feat/a')).toBe(head);
    expect(createCalls()).toHaveLength(1);
    expect(h.deliveries()).toHaveLength(1);
  });
});

describe('Given PACT stopped while the PR was being opened (sc.1, SC-005)', () => {
  it('When no PR is noted in the request, Then exactly one PR is opened after the restart', async () => {
    const { dev } = await h.team('a');
    const held = h.holdGh(isCreate);
    const request = await h.request(dev.id);
    await held.reached;
    expect(h.deliveries()[0]?.state).toBe('opening');
    expect(h.deliveries()[0]?.pr).toBeNull();
    const head = git(dev.worktreePath, 'rev-parse', 'HEAD');

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(h.prHead(1)).toBe(head);
    expect(createCalls()).toHaveLength(1);
    expect(h.deliveries()).toHaveLength(1);
  });

  it('When the PR is noted in the request, Then it is followed again by its number and no other is created', async () => {
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    expect(createCalls()).toHaveLength(1);
    // The crash came between the note of the PR and the write of `watching`.
    await rewrite(request.id, { state: 'opening' });

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(createCalls()).toHaveLength(1);
    expect(Object.keys(h.ghStateNow().prs)).toEqual(['1']);
    expect(h.deliveries()).toHaveLength(1);
  });
});

describe('Given PACT stopped while the CI was followed (sc.1, SC-005) — already in place, kept as the guard', () => {
  it('When PACT starts again once or twice, Then the follow goes on without a new PR, and the green CI merges ONCE', async () => {
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    await h.setSettings({ auto: true });
    h.setChecks(head, h.RUNNING);

    await h.restart({ restore: false });
    await h.restart({ restore: false });
    const reads = h.ghLog().filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length;
    await h.waitFor(
      () =>
        h.ghLog().filter(([a, b]) => a === 'api' && /\/check-runs$/.test(b ?? '')).length >=
        reads + 2,
      'the checks were not read again after the restart',
    );
    expect(h.mergeCalls()).toHaveLength(0);
    h.setChecks(head, h.GREEN);

    await h.until(request.id, ['merged'], STEP_MS);
    await sleep(300);
    expect(createCalls()).toHaveLength(1);
    expect(h.mergeCalls()).toHaveLength(1);
    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head }]);
    // The dev and the tester are closed once each, at the merge only.
    expect(h.closed).toHaveLength(2);
    expect(h.closed.map((c) => c.id)).toContain(dev.id);
  });
});

describe('Given PACT stopped while the merge was asked (sc.1, SC-005) — already in place, kept as the guard', () => {
  it('When the merge had not left, Then it is made once after the restart', async () => {
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    await h.setSettings({ auto: true });
    // The call of the merge is held: `merging` is saved, nothing reached the forge.
    const held = h.holdGh(isMerge);
    h.setChecks(head, h.GREEN);
    await held.reached;
    expect(h.deliveries()[0]?.state).toBe('merging');
    expect(h.mergeCalls()).toHaveLength(0);

    await h.restart({ restore: false });

    await h.until(request.id, ['merged'], STEP_MS);
    expect(h.mergeCalls()).toHaveLength(1);
    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head }]);
    expect(createCalls()).toHaveLength(1);
  });

  it('When the merge had gone through on the forge, Then the request ends merged and merge is NOT asked again', async () => {
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    await h.setSettings({ auto: true });
    const held = h.holdGh(isMerge);
    h.setChecks(head, h.GREEN);
    await held.reached;
    // The forge merged it, PACT did not live to hear it.
    h.patchPr(1, { state: 'MERGED' });

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['merged'], STEP_MS);
    await sleep(300);
    expect(done.state).toBe('merged');
    expect(h.mergeCalls()).toHaveLength(0);
    expect(createCalls()).toHaveLength(1);
    expect(h.deliveryMessages().filter((m) => m.delivery?.outcome === 'merged')).toHaveLength(1);
  });
});
