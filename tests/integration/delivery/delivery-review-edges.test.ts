import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from './delivery-harness';

// 008 T039 — the edges of `decide` and of the resume of a PR that the main scenarios of
// delivery-review.test.ts do not reach: a decision on a request that no longer waits for one, and a
// PR that cannot be read (the forge answers an error that is not « no such PR »).

let h: DeliveryHarness;

afterEach(async () => {
  await h.dispose();
});

describe('a decision on a request that does not wait for one', () => {
  it('Given a local merge that was refused, When the user decides again, Then it is rejected and nothing changes', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    expect(request.state).toBe('reviewing');
    await h.delivery.decide({
      deliveryId: request.id,
      decision: 'refuse',
      head: request.frozenCommit,
      reason: 'Non.',
    });

    const again = await h.delivery
      .decide({ deliveryId: request.id, decision: 'validate', head: request.frozenCommit })
      .then(
        () => 'accepted',
        () => 'rejected',
      );

    expect(again).toBe('rejected');
    expect(h.deliveryOf(request.id).state).toBe('user-refused');
  });

  it('Given a PR that is merged, When the user decides, Then it is rejected', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(request.id, ['reviewing']);
    await h.delivery.decide({ deliveryId: request.id, decision: 'validate', head });
    await h.until(request.id, ['merged']);

    const late = await h.delivery
      .decide({ deliveryId: request.id, decision: 'validate', head })
      .then(
        () => 'accepted',
        () => 'rejected',
      );

    expect(late).toBe('rejected');
    expect(h.mergeCalls()).toHaveLength(1);
  });
});

describe('a PR that cannot be read when a request resumes it', () => {
  it('Given a forge that fails on the PR, When a new request is taken, Then it is refused: nothing is pushed nor created', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const team = await h.team('a');
    const first = await h.request(team.dev.id);
    await h.until(first.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(first.id, ['reviewing']);
    await h.delivery.decide({
      deliveryId: first.id,
      decision: 'refuse',
      head,
      reason: 'Ajoute le cas vide.',
    });
    await h.commit(team.dev, { 'src/fix.ts': 'export const fix = 1;\n' }, 'fix');
    await h.acceptLoop(team.dev, team.tester, { issue: team.issue });
    h.beforeGh(
      ([a, b]) => a === 'pr' && b === 'view',
      () => Promise.reject(new Error('HTTP 502: Bad Gateway')),
    );

    const again = await h.request(team.dev.id);
    const refused = await h.until(again.id, ['refused']);

    expect(refused.reason).toContain('PR #1');
    expect(h.remoteHead('feat/a')).toBe(head);
    expect(h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create')).toHaveLength(1);
  });
});
