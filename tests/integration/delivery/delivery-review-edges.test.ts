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

describe('how the forge says a PR cannot be read', () => {
  async function refusedOnce() {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const team = await h.team('a');
    const first = await h.request(team.dev.id);
    await h.until(first.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(first.id, ['reviewing']);
    await h.delivery.decide({ deliveryId: first.id, decision: 'refuse', head, reason: 'Non.' });
    await h.commit(team.dev, { 'src/fix.ts': 'export const fix = 1;\n' }, 'fix');
    await h.acceptLoop(team.dev, team.tester, { issue: team.issue });
    return team;
  }

  it('Given a failure that is not an Error, When a new request is taken, Then it is refused', async () => {
    const team = await refusedOnce();
    h.beforeGh(
      ([a, b]) => a === 'pr' && b === 'view',
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject('boom'),
    );
    const again = await h.request(team.dev.id);
    expect((await h.until(again.id, ['refused'])).reason).toContain('PR #1');
  });

  it('Given a stderr that says no PR is there, When a new request is taken, Then a new PR is tried', async () => {
    const team = await refusedOnce();
    h.beforeGh(
      ([a, b]) => a === 'pr' && b === 'view',
      () =>
        Promise.reject(Object.assign(new Error('gh failed'), { stderr: 'no pull requests found' })),
    );
    const again = await h.request(team.dev.id);
    // The fake forge still holds the PR, so the new one is refused there: the point is that PACT
    // took the PR for gone and tried to open another.
    const ended = await h.until(again.id, ['refused', 'watching']);
    expect(ended.reason ?? '').not.toContain('pas pu être lue');
    expect(h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create')).toHaveLength(2);
  });
});

describe('a PR whose pushed head was not recorded', () => {
  it('Given no pushed head, When the user refuses on the frozen commit, Then the frozen commit is the head asked for', async () => {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    h.setChecks(h.prHead(1), h.GREEN);
    await h.until(request.id, ['reviewing']);
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) => (d.id === request.id ? { ...d, pushedHead: null } : d)),
    }));

    await h.delivery.decide({
      deliveryId: request.id,
      decision: 'refuse',
      head: request.frozenCommit,
      reason: 'Non.',
    });

    expect(h.deliveryOf(request.id).state).toBe('user-refused');
  });
});

describe('a refusal needs a reason', () => {
  it.each([
    ['a blank one', '   '],
    ['one that is too long', 'x'.repeat(2_001)],
  ])(
    'Given %s, When the user refuses, Then it is rejected and the PR still waits',
    async (_w, reason) => {
      h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
      const { dev } = await h.team('a');
      const request = await h.request(dev.id);
      await h.until(request.id, ['watching']);
      const head = h.prHead(1);
      h.setChecks(head, h.GREEN);
      await h.until(request.id, ['reviewing']);

      const result = await h.delivery
        .decide({ deliveryId: request.id, decision: 'refuse', head, reason })
        .then(
          () => 'accepted',
          () => 'rejected',
        );

      expect(result).toBe('rejected');
      expect(h.deliveryOf(request.id).state).toBe('reviewing');
    },
  );
});

describe('« Ouvrir la PR » opens the PR of the project, by its number, whatever was stored', () => {
  async function followed(ghRemote?: string) {
    h = await createDeliveryHarness({
      pollMs: 50,
      required: ['ci'],
      ...(ghRemote ? { ghRemote } : {}),
    });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    return request.id;
  }
  const tamper = async (id: string, url: string) => {
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) =>
        d.id === id && d.pr ? { ...d, pr: { ...d.pr, url } } : d,
      ),
    }));
  };

  it('Given the PR followed, When the address is asked, Then it is built from the repository and the number', async () => {
    const id = await followed();
    expect(await h.delivery.prUrl(id)).toBe('https://github.com/pact/test/pull/1');
  });

  it.each([
    ['another number', 'https://github.com/pact/test/pull/2'],
    ['a deeper path', 'https://github.com/a/b/pull/2'],
    ['another repository', 'https://github.com/a/b/pull/1'],
    ['a path that climbs', 'https://github.com/../x/pull/1'],
    ['another host', 'https://evil.example/pact/test/pull/1'],
  ])(
    'Given a stored address with %s, When the address is asked, Then the stored text is ignored',
    async (_what, url) => {
      const id = await followed();
      await tamper(id, url);
      expect(await h.delivery.prUrl(id)).toBe('https://github.com/pact/test/pull/1');
    },
  );

  it('Given a delivery that does not exist, When the address is asked, Then there is nothing to open', async () => {
    await followed();
    expect(await h.delivery.prUrl('00000000-0000-4000-8000-000000000099')).toBeNull();
  });

  it.each([['../x'], ['a/b/c'], ['a/..'], ['onlyone']])(
    'Given a repository named %s, When the address is asked, Then there is nothing to open',
    async (name) => {
      const id = await followed();
      (h.delivery as unknown as { repos: Map<string, string> }).repos.set(h.workspaceId, name);
      expect(await h.delivery.prUrl(id)).toBeNull();
    },
  );

  it('Given a repository that cannot be read, When the address is asked, Then there is nothing to open', async () => {
    const id = await followed();
    const repos = (h.delivery as unknown as { repos: Map<string, string> }).repos;
    repos.clear();
    h.beforeGh(
      () => true,
      () => Promise.reject(new Error('gh: not logged in')),
    );
    expect(await h.delivery.prUrl(id)).toBeNull();
  });

  it('Given a local merge, When the address is asked, Then there is nothing to open', async () => {
    h = await createDeliveryHarness({ remote: false });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    expect(await h.delivery.prUrl(request.id)).toBeNull();
  });
});

describe('a decision does not race a merge under way', () => {
  async function reviewing() {
    h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
    const { dev } = await h.team('a');
    const request = await h.request(dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(request.id, ['reviewing']);
    return { id: request.id, head };
  }
  const isMerge = ([a, b]: string[]) => a === 'pr' && b === 'merge';

  it('Given a merge that is under way, When the user refuses, Then it is rejected and the merge goes through', async () => {
    const { id, head } = await reviewing();
    const held = h.holdGh(isMerge);
    const merging = h.delivery.decide({ deliveryId: id, decision: 'validate', head });
    await held.reached;

    const refusal = await h.delivery
      .decide({ deliveryId: id, decision: 'refuse', head, reason: 'Trop tard.' })
      .then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
      );
    held.release();
    await merging;
    await h.until(id, ['merged']);

    expect(refusal).not.toBe('accepted');
    expect(h.mergeCalls()).toHaveLength(1);
    expect(h.deliveryOf(id).state).toBe('merged');
  });

  it('Given a merge that is under way, When the user validates again, Then the click is ignored', async () => {
    const { id, head } = await reviewing();
    const held = h.holdGh(isMerge);
    const first = h.delivery.decide({ deliveryId: id, decision: 'validate', head });
    await held.reached;

    const second = await h.delivery.decide({ deliveryId: id, decision: 'validate', head });
    held.release();
    await first;
    await h.until(id, ['merged']);

    expect(second.id).toBe(id);
    expect(h.mergeCalls()).toHaveLength(1);
  });
});
