import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '../../../src/shared/model';
import { deriveTodos } from '../../../src/shared/todo';
import { createDeliveryHarness, git, short, type DeliveryHarness } from './delivery-harness';

// 008 T035 — User Story 3: read, Validate or Refuse (sc.1 to 6 and 12 to 15, FR-013, FR-027, and a CI
// that turns red before the decision). A repository, a bare remote, the contractual fake `gh` over a
// JSON file, the real services around. Nothing real, no `--auto`, no `refs/pull/*`. The CI is driven by
// the test (`setChecks`); the watcher reads every 50 ms (`pollMs`). A CI is configured (a required
// check): a head with no check is « pending », never green.
//
// RED until T039. THE API THIS FILE ASSUMES (fixed by contracts/ui.md and data-model.md):
//   delivery.decide({ deliveryId, decision: 'validate' | 'refuse', head, reason? }) on a PR of the
//     channel `github` in state `reviewing` (the head is the head of the PR PACT pushed, the one the
//     item shows); one merge at most per request, whoever clicks and however often; a refusal without
//     a reason is rejected and says « motif »; a stale head is rejected and nothing happens;
//   a refusal ends the request in `user-refused` (outcome `user-refused`, the PR is kept), sends the
//     reason to the dev as a `verdict` message (a defect), opens the next round, and writes
//     `review.refusedOnce: true`; the next request of the same branch resumes the PR by its number
//     and is shown to the user once more, Auto or not (`review.required`);
//   the item `delivery-review` carries `delivery: { id, head, url, verdict }` (see TodoItem tests).

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

/** A dev accepted and delivered; the CI turns green: the PR waits for a review (Auto off). */
async function reviewing(suffix = 'a') {
  const team = await h.team(suffix);
  const request = await h.request(team.dev.id);
  await h.until(request.id, ['watching']);
  const head = h.prHead(1);
  h.setChecks(head, h.GREEN);
  const delivery = await h.until(request.id, ['reviewing']);
  return { ...team, delivery, id: delivery.id, head, branch: `feat/${suffix}` };
}

/** The dev works again after a refusal; the tester accepts; the user's gesture is made again. */
async function redeliver(team: Awaited<ReturnType<typeof reviewing>>, file = 'fix') {
  await h.commit(team.dev, { [`src/${file}.ts`]: `export const ${file} = 1;\n` }, file);
  await h.acceptLoop(team.dev, team.tester, { issue: team.issue });
  return h.request(team.dev.id);
}

/** A foreign commit on the PR branch drops the request; the remote then goes back to PACT's head. */
async function drop(team: Awaited<ReturnType<typeof reviewing>>) {
  const pushed = h.remoteHead(team.branch) ?? '';
  h.pushToOrigin(team.branch, { 'src/intrus.ts': 'export const x = 1;\n' }, 'intrus');
  await h.until(team.id, ['dropped']);
  git(h.bare, 'update-ref', `refs/heads/${team.branch}`, pushed);
  git(h.repo, 'fetch', '-q', 'origin');
}

describe('sc.1 — the item', () => {
  it('Given Auto off and a CI green, When the user opens À faire, Then there is one item « Relire la PR #1 » that carries the delivery and the head to decide on', async () => {
    const { id, head, issue } = await reviewing();

    const items = reviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'delivery-review',
      delivery: { id, head },
    });
    expect(items[0]?.title).toBe(`◎ Relire la PR #1 · ${issue} · ${short(head)}`);
    expect(h.mergeCalls()).toEqual([]);
    expect(messagesOf('review-requested')).toHaveLength(1);
  });
});

describe('sc.2 — Valider, once', () => {
  it('Given the item, When Valider is clicked twice at once, Then one merge leaves, of the head shown, with no other confirmation', async () => {
    const { id, head } = await reviewing();

    const results = await Promise.allSettled([
      h.delivery.decide({ deliveryId: id, decision: 'validate', head }),
      h.delivery.decide({ deliveryId: id, decision: 'validate', head }),
    ]);
    await h.until(id, ['merged']);

    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head }]);
    expect(h.ghLog().flat().join(' ')).not.toContain('--auto');
    expect(h.deliveries()[0]?.state).toBe('merged');
    expect(reviewItems()).toEqual([]);
  });

  it('Given the item and a click on Valider that is still under way, When a second click comes, Then it is ignored: no second merge, no failure of the first', async () => {
    const { id, head } = await reviewing();
    const held = h.holdGh(([a, b]) => a === 'pr' && b === 'merge');

    const first = h.delivery.decide({ deliveryId: id, decision: 'validate', head });
    await held.reached;
    const second = await h.delivery
      .decide({ deliveryId: id, decision: 'validate', head })
      .catch(() => null);
    held.release();
    await first;
    await h.until(id, ['merged']);

    expect(second === null || second.id === id).toBe(true);
    expect(h.mergeCalls()).toHaveLength(1);
  });
});

describe('sc.3 — Refuser needs a reason', () => {
  it.each([
    ['(none)', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])(
    'Given the item, When the user refuses with a reason that is %s, Then it is rejected with the reason « motif », and nothing changed',
    async (_what, reason) => {
      const { id, head, dev } = await reviewing();
      const before = h.messagesTo(dev.id).length;

      const outcome = await h.delivery
        .decide({
          deliveryId: id,
          decision: 'refuse',
          head,
          ...(reason === undefined ? {} : { reason }),
        })
        .then(
          () => 'accepted',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );

      expect(outcome).toMatch(/motif/i);
      expect(h.deliveryOf(id).state).toBe('reviewing');
      expect(h.messagesTo(dev.id)).toHaveLength(before);
      expect(h.workspace().loops[0]?.round).toBe(1);
      expect(reviewItems()).toHaveLength(1);
    },
  );
});

describe('sc.4 — Refuser with a reason', () => {
  it('Given a reason, When the user refuses, Then the dev receives it as a defect, a round is counted and the PR stays open', async () => {
    const { id, head, dev } = await reviewing();

    await h.delivery.decide({
      deliveryId: id,
      decision: 'refuse',
      head,
      reason: 'Le champ e-mail accepte une chaîne vide.',
    });

    const refused = h.deliveryOf(id);
    expect(refused.state).toBe('user-refused');
    expect(refused.pr?.number).toBe(1);
    expect(refused.review.refusedOnce).toBe(true);
    const toDev = h.messagesTo(dev.id).filter((m) => m.kind === 'verdict');
    expect(toDev.some((m) => m.text.includes('Le champ e-mail accepte une chaîne vide.'))).toBe(
      true,
    );
    expect(h.workspace().loops[0]).toMatchObject({ state: 'running', round: 2 });
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.mergeCalls()).toEqual([]);
    expect(messagesOf('user-refused')).toHaveLength(1);
    expect(reviewItems()).toEqual([]);
  });

  it('Given a refusal, When the user clicks Refuser twice at once, Then one round is counted and one message goes to the dev', async () => {
    const { id, head, dev } = await reviewing();
    const input = { deliveryId: id, decision: 'refuse' as const, head, reason: 'Trop fragile.' };

    await Promise.allSettled([h.delivery.decide(input), h.delivery.decide(input)]);

    expect(h.workspace().loops[0]?.round).toBe(2);
    expect(
      h.messagesTo(dev.id).filter((m) => m.kind === 'verdict' && m.text.includes('Trop fragile.')),
    ).toHaveLength(1);
    expect(messagesOf('user-refused')).toHaveLength(1);
  });
});

describe('sc.5 — back to the user once after a refusal, Auto or not', () => {
  it('Given a refusal and Auto turned on since, When the new request reaches a green CI, Then the item comes back to the user and nothing is merged', async () => {
    const team = await reviewing();
    await h.delivery.decide({
      deliveryId: team.id,
      decision: 'refuse',
      head: team.head,
      reason: 'Ajoute le cas vide.',
    });
    await h.setSettings({ auto: true });

    const again = await redeliver(team);
    await h.until(again.id, ['watching']);
    const head = h.prHead(1);
    expect(head).not.toBe(team.head);
    h.setChecks(head, h.GREEN);
    await h.until(again.id, ['reviewing']);
    await sleep(300);

    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(reviewItems()).toHaveLength(1);
    expect(reviewItems()[0]?.delivery).toMatchObject({ id: again.id, head });
  });

  it('Given that second review, When the user validates, Then the new head is merged, once', async () => {
    const team = await reviewing();
    await h.delivery.decide({
      deliveryId: team.id,
      decision: 'refuse',
      head: team.head,
      reason: 'Ajoute le cas vide.',
    });
    const again = await redeliver(team);
    await h.until(again.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(again.id, ['reviewing']);

    await h.delivery.decide({ deliveryId: again.id, decision: 'validate', head });
    await h.until(again.id, ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
  });
});

describe('sc.6 and sc.12 — a new request resumes the open PR, by its number', () => {
  it('Given a refusal and a verdict accepted again, When the new request is taken, Then it resumes PR #1 and opens no other', async () => {
    const team = await reviewing();
    await h.delivery.decide({
      deliveryId: team.id,
      decision: 'refuse',
      head: team.head,
      reason: 'Ajoute le cas vide.',
    });

    const again = await redeliver(team);
    await h.until(again.id, ['watching']);

    expect(prCreates()).toHaveLength(1);
    expect(h.deliveryOf(again.id).pr?.number).toBe(1);
    expect(Object.keys(h.ghStateNow().prs)).toEqual(['1']);
    expect(h.prHead(1)).toBe(h.deliveryOf(again.id).pushedHead);
  });

  it('Given a request that fell, When the new request resumes its PR, Then the PR is read by its number BEFORE the push, and never searched by branch name nor listed', async () => {
    const team = await reviewing();
    await drop(team);
    const mark = h.ghLog().length;
    const timelineMark = h.timeline.length;

    const again = await redeliver(team);
    await h.until(again.id, ['watching']);

    const prCalls = h
      .ghLog()
      .slice(mark)
      .filter(([a]) => a === 'pr');
    expect(prCalls[0]?.slice(0, 3)).toEqual(['pr', 'view', '1']);
    expect(prCalls.some(([, b]) => b === 'create' || b === 'list')).toBe(false);
    expect(h.ghLog().slice(mark).flat().join(' ')).not.toMatch(/search|--head|\blist\b/);
    const steps = h.timeline.slice(timelineMark);
    expect(steps.indexOf('gh:pr view')).toBeGreaterThan(-1);
    expect(steps.indexOf('gh:pr view')).toBeLessThan(steps.indexOf('pushBranch'));
    expect(prCreates()).toHaveLength(1);
    expect(h.deliveryOf(again.id).pr).toMatchObject({ number: 1, expectedAuthor: 'pact-user' });
  });
});

describe('sc.13 — a PR closed, merged or gone is not resumed', () => {
  it.each([
    [
      'closed',
      () => {
        h.patchPr(1, { state: 'CLOSED' });
      },
    ],
    [
      'merged',
      () => {
        h.patchPr(1, { state: 'MERGED' });
      },
    ],
    [
      'gone',
      () => {
        const rest = Object.entries(h.ghStateNow().prs).filter(([number]) => number !== '1');
        h.setGhState({ prs: Object.fromEntries(rest), nextPr: 2 });
      },
    ],
  ])(
    'Given a request that fell whose PR is %s, When a new request is taken, Then a new PR is created',
    async (_what, change) => {
      const team = await reviewing();
      await drop(team);
      change();

      const again = await redeliver(team);
      await h.until(again.id, ['watching']);

      expect(prCreates()).toHaveLength(2);
      expect(h.deliveryOf(again.id).pr).not.toBeNull();
      expect(h.deliveryOf(again.id).state).toBe('watching');
    },
  );
});

describe('sc.14 — a PR that is no longer the expected one', () => {
  it.each([
    ['another author', { author: { login: 'someone-else' } }],
    ['a fork as source', { isCrossRepository: true }],
  ])(
    'Given a request that fell whose open PR has %s, When a new request is taken, Then PACT neither resumes it nor creates another, and warns the user',
    async (_what, change) => {
      const team = await reviewing();
      await drop(team);
      h.patchPr(1, change);
      const alerts = messagesOf('alert').length;

      const again = await redeliver(team);
      await h.waitFor(() => messagesOf('alert').length > alerts, 'no alert was told');
      await sleep(200);

      expect(prCreates()).toHaveLength(1);
      expect(h.mergeCalls()).toEqual([]);
      expect(h.deliveryOf(again.id).state).not.toBe('watching');
      expect(h.deliveryOf(again.id).state).not.toBe('merged');
      expect(h.remoteHead(team.branch)).toBe(team.head);
      expect(h.prStateOnForge(1)).toBe('OPEN');
    },
  );
});

describe('sc.15 — after the push, the head of the PR is the head of the request', () => {
  it('Given a PR resumed whose head is not the commit PACT pushed, When PACT checks it after the push, Then the resume stops, nothing is created, followed or merged, and the user is warned', async () => {
    const team = await reviewing();
    await drop(team);
    h.patchPr(1, { frozenHead: true, headRefOid: 'a'.repeat(40) });
    const alerts = messagesOf('alert').length;

    const again = await redeliver(team);
    await h.waitFor(() => messagesOf('alert').length > alerts, 'no alert was told');
    await sleep(200);

    expect(prCreates()).toHaveLength(1);
    expect(h.mergeCalls()).toEqual([]);
    expect(h.deliveryOf(again.id).state).not.toBe('watching');
    expect(h.prStateOnForge(1)).toBe('OPEN');
  });

  it('Given a PR resumed on the commit PACT pushed, When the user validates, Then the head merged is that very commit', async () => {
    const team = await reviewing();
    await drop(team);

    const again = await redeliver(team);
    await h.until(again.id, ['watching']);
    const head = h.prHead(1);
    expect(head).toBe(h.deliveryOf(again.id).pushedHead);
    h.setChecks(head, h.GREEN);
    await h.until(again.id, ['reviewing']);
    await h.delivery.decide({ deliveryId: again.id, decision: 'validate', head });
    await h.until(again.id, ['merged']);

    expect(h.mergeCalls()).toEqual([['pr', 'merge', '1', '--squash', '--match-head-commit', head]]);
  });
});

describe('the head shown (FR-031)', () => {
  it('Given the item, When a decision comes on another head than the one shown, Then it is rejected and nothing is merged', async () => {
    const { id } = await reviewing();

    const outcome = await h.delivery
      .decide({ deliveryId: id, decision: 'validate', head: 'b'.repeat(40) })
      .then(
        () => 'accepted',
        () => 'rejected',
      );

    expect(outcome).toBe('rejected');
    expect(h.mergeCalls()).toEqual([]);
    expect(h.deliveryOf(id).state).toBe('reviewing');
  });
});

describe('FR-013 — no check read, no Valider', () => {
  it('Given a CI configured and no check read yet on a PR without a verdict, When the user validates, Then it is refused and nothing is merged', async () => {
    const dev = await h.addAgent('dev', { branch: 'feat/u' });
    await h.commit(dev, { 'src/u.ts': 'export const u = 1;\n' }, 'feat');
    const request = await h.request(dev.id, { unverified: true, by: 'user' });
    const watching = await h.until(request.id, ['watching']);
    const head = h.prHead(1);

    const outcome = await h.delivery
      .decide({ deliveryId: watching.id, decision: 'validate', head })
      .then(
        () => 'accepted',
        () => 'rejected',
      );
    await sleep(200);

    expect(outcome).toBe('rejected');
    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
  });
});

describe('FR-027 — one decision, in one place, whatever the state of the agent', () => {
  it('Given the dev works again, When the user validates, Then one merge leaves with no other dialog, and the item is the only place that asks', async () => {
    const { id, head, dev } = await reviewing();
    await h.setAgentState(dev, 'working');

    const todos = deriveTodos(h.workspace(), names);
    expect(todos.filter((t) => t.kind === 'delivery-review')).toHaveLength(1);
    expect(todos.filter((t) => ['review', 'decide', 'answer', 'prompt'].includes(t.kind))).toEqual(
      [],
    );
    await h.delivery.decide({ deliveryId: id, decision: 'validate', head });
    await h.until(id, ['merged']);

    expect(h.mergeCalls()).toHaveLength(1);
    expect(h.merges()).toEqual([{ number: 1, mode: 'squash', head }]);
  });
});

describe('a CI that turns red before the decision', () => {
  it('Given an item under review, When the CI turns red, Then the item is withdrawn and a Valider that comes after merges nothing', async () => {
    const { id, head, dev } = await reviewing();
    expect(reviewItems()).toHaveLength(1);

    h.setChecks(head, [{ id: 11, name: 'ci', status: 'completed', conclusion: 'failure' }]);
    await h.until(id, ['ci-red']);

    expect(reviewItems()).toEqual([]);
    const late = await h.delivery.decide({ deliveryId: id, decision: 'validate', head }).then(
      () => 'accepted',
      () => 'rejected',
    );
    expect(late).toBe('rejected');
    expect(h.mergeCalls()).toEqual([]);
    expect(h.prStateOnForge(1)).toBe('OPEN');
    expect(h.messagesTo(dev.id).some((m) => m.text.includes('ci'))).toBe(true);
  });
});
