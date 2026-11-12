import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Integration } from '../../../src/shared/review';
import { createDeliveryHarness, git, type DeliveryHarness } from '../delivery/delivery-harness';

// 008 T049 — US6 sc.5, FR-028, research R20: a manual integration of an agent that has a local request
// is never reported as the integration of the request, nor the other way round. The follow is by
// `requestId`, never by `agentId`.
//
// What is GREEN already (kept as the guard of FR-028; `integrationState` filters on `requestId` since
// phase 3): the first three tests, with the services alive.
// What is RED, and why: the last two, across a restart. They need `IntegrationService.restore()` (T051,
// R19), and that the restored integrations keep their `requestId` — or their absence of one — so that
// the follow still tells them apart.
//
// ASSUMED API: the same as integration-restore.test.ts (`restore(): Promise<Integration[]>`); a manual
// integration is `IntegrationService.start({ agentId, mode, message, after })` without `requestId`,
// as « Intégrer » of the review view does.

let h: DeliveryHarness;

beforeEach(async () => {
  h = await createDeliveryHarness({ remote: false });
});

afterEach(async () => {
  await h.dispose();
});

/** The dev and main both rewrite README.md: any integration of the dev stops on one conflict. */
async function conflictingDev() {
  const { dev, tester, issue } = await h.team('a', { accept: false });
  await h.commit(dev, { 'README.md': '# test de l’agent\n' }, 'readme');
  await h.acceptLoop(dev, tester, { issue });
  const request = await h.request(dev.id);
  expect(h.deliveryOf(request.id).state).toBe('reviewing');
  await writeFile(join(h.repo, 'README.md'), '# test de main\n');
  git(h.repo, 'add', '-A');
  git(h.repo, 'commit', '-q', '-m', 'main moves');
  return { dev, issue, request };
}

const manual = (agentId: string) =>
  h.integration.start({
    agentId,
    mode: 'squash',
    message: 'Intégration à la main',
    after: { closeTile: false, removeWorktree: false },
  });
const outcomes = () => h.deliveryMessages().map((m) => m.delivery?.outcome);
const conflictedOf = (requestId?: string): Integration | undefined =>
  h.integrations.findLast(
    (i) => i.state === 'conflicted' && (requestId === undefined || i.requestId === requestId),
  );
const keepMain = { path: 'README.md', hunk: 0, choice: 'main' as const };

describe('Given a request for an agent and a manual integration of the same agent (sc.5, FR-028)', () => {
  it('When the manual integration is cancelled, Then the request is neither failed nor changed, and the orchestrator hears nothing', async () => {
    const { dev, request } = await conflictingDev();
    const states = h.integrations.length;

    const { id } = await manual(dev.id);
    await h.integration.cancel(id);

    expect(h.integrations.length).toBeGreaterThan(states);
    expect(h.integrations.every((i) => i.requestId === undefined)).toBe(true);
    expect(h.deliveryOf(request.id).state).toBe('reviewing');
    expect(h.deliveryOf(request.id).reason).toBeNull();
    expect(outcomes()).not.toContain('merge-failed');
  });

  it('When the manual integration lands, Then it is not the end of the request: not merged, loop and issue as they were', async () => {
    const { dev, issue, request } = await conflictingDev();

    const { id } = await manual(dev.id);
    await h.integration.resolve(id, { path: 'README.md', hunk: 0, choice: 'agent' });
    await h.integration.finish(id);

    expect(h.integrations.at(-1)).toMatchObject({ id, state: 'integrated' });
    expect(h.deliveryOf(request.id).state).toBe('reviewing');
    expect(outcomes()).not.toContain('merged');
    // The request is under way: the loop is `delivering`, as the manual integration found it.
    expect(h.workspace().loops.find((l) => l.issueId === issue)?.state).toBe('delivering');
    expect(h.workspace().issues.find((i) => i.id === issue)?.state).toBe('in-progress');
  });

  it('When both are on conflicts and the manual one is finished, Then only the end of the request is the end of the request', async () => {
    const { dev, request } = await conflictingDev();
    const mine = await manual(dev.id);
    await h.delivery.decide({
      deliveryId: request.id,
      decision: 'validate',
      head: git(dev.worktreePath, 'rev-parse', 'HEAD'),
    });
    await h.waitFor(() => conflictedOf(request.id) !== undefined, 'the request did not stop');
    const theirs = (conflictedOf(request.id) as Integration).id;
    expect(theirs).not.toBe(mine.id);

    await h.integration.cancel(mine.id);
    expect(h.deliveryOf(request.id).state).toBe('merging');
    expect(outcomes()).not.toContain('merge-failed');

    await h.integration.resolve(theirs, { path: 'README.md', hunk: 0, choice: 'agent' });
    await h.integration.finish(theirs);
    await h.until(request.id, ['merged']);
    expect(outcomes().filter((o) => o === 'merged')).toHaveLength(1);
  });
});

// Across a restart: the two integrations are restored, each with what it carries.
describe('Given a request and a manual integration both on conflicts, and PACT that restarts (sc.5, SC-005)', () => {
  async function both() {
    const { dev, request } = await conflictingDev();
    const mine = await manual(dev.id);
    await h.delivery.decide({
      deliveryId: request.id,
      decision: 'validate',
      head: git(dev.worktreePath, 'rev-parse', 'HEAD'),
    });
    await h.waitFor(() => conflictedOf(request.id) !== undefined, 'the request did not stop');
    return { dev, request, mine: mine.id, theirs: (conflictedOf(request.id) as Integration).id };
  }

  it('When the manual one is cancelled after the restart, Then the request is not failed: it is still merging', async () => {
    const { request, mine, theirs } = await both();

    await h.restart();
    await h.integration.cancel(mine);

    expect(h.integrations.at(-1)).toMatchObject({ id: mine, state: 'cancelled' });
    expect(h.integrations.at(-1)?.requestId).toBeUndefined();
    expect(h.deliveryOf(request.id).state).toBe('merging');
    expect(outcomes()).not.toContain('merge-failed');
    // The other one is still there to finish.
    await h.integration.resolve(theirs, keepMain);
  });

  it('When the one of the request is finished after the restart, Then it alone ends the request, and the manual one is not reported with it', async () => {
    const { request, mine, theirs } = await both();

    await h.restart();
    await h.integration.resolve(theirs, { path: 'README.md', hunk: 0, choice: 'agent' });
    await h.integration.finish(theirs);

    await h.until(request.id, ['merged'], 8_000);
    expect(outcomes().filter((o) => o === 'merged')).toHaveLength(1);
    // The manual one is untouched, resolvable still, and its end changes nothing for the request.
    await h.integration.cancel(mine);
    expect(h.deliveryOf(request.id).state).toBe('merged');
    expect(outcomes()).not.toContain('merge-failed');
  });
});
