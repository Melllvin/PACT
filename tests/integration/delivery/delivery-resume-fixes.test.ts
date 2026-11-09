import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, git, type DeliveryHarness } from './delivery-harness';

// 008 US6 sc.1, SC-005, FR-025, FR-030, FR-031 — the two defects of the verdict on ec035313:
//  1. a resume in `pushing` when the push already went out AND main has moved since: the rebase would
//     give another commit, the request must go on from the commit PACT recorded, not be refused;
//  2. a crash after `gh pr create`, before the number is noted: the number comes from gh's own
//     « already exists » error (no search), the PR is checked (FR-031) and followed, or refused in French.

let h: DeliveryHarness;

beforeEach(async () => {
  h = await createDeliveryHarness({ pollMs: 50, required: ['ci'] });
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const STEP_MS = 8_000;
const WITNESS = 'PACT-INJECTION-WITNESS';
const isCreate = (args: string[]) => args[0] === 'pr' && args[1] === 'create';
const createCalls = () => h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');

async function rewrite(id: string, change: Record<string, unknown>) {
  await h.workspaces.update(h.workspaceId, (ws) => ({
    ...ws,
    deliveries: ws.deliveries.map((d) => (d.id === id ? { ...d, ...change } : d)),
  }));
}

describe('Given a push that went out, main that moved, and PACT that restarts in `pushing`', () => {
  it('When PACT starts again, Then it goes on from the commit it recorded: no refusal, one PR on that commit', async () => {
    const { dev } = await h.team('a');
    const held = h.holdGh(isCreate);
    const request = await h.request(dev.id);
    await held.reached;
    const pushed = h.remoteHead('feat/a');
    expect(pushed).not.toBeNull();
    // The crash came before the write of `opening`; meanwhile a colleague moved main.
    await rewrite(request.id, { state: 'pushing', pushedHead: null, pr: null });
    h.pushToOrigin('main', { 'other.txt': 'main moved\n' }, 'main moves');

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(h.remoteHead('feat/a')).toBe(pushed);
    expect(h.prHead(1)).toBe(pushed);
    expect(h.deliveries()).toHaveLength(1);
  });

  it('When the remote head is NOT one PACT pushed, Then the lease still refuses and nothing is created', async () => {
    const { dev } = await h.team('a');
    const held = h.holdGh(isCreate);
    const request = await h.request(dev.id);
    await held.reached;
    await rewrite(request.id, { state: 'pushing', pushedHead: null, pr: null });
    const foreign = h.pushToOrigin('feat/a', { 'foreign.txt': 'someone else\n' }, 'foreign');

    await h.restart({ restore: false });

    const refused = await h.until(request.id, ['refused'], STEP_MS);
    expect(refused.reason).toContain('a bougé');
    expect(h.remoteHead('feat/a')).toBe(foreign);
    expect(createCalls()).toHaveLength(0);
  });
});

describe('Given a PR created on the forge and PACT that stopped before noting its number', () => {
  /** The crash: `gh pr create` went through, the answer was lost; the request says `opening`, no PR. */
  async function crashed(patch: Record<string, unknown> = {}) {
    const { dev } = await h.team('a');
    const held = h.holdGh(isCreate);
    const request = await h.request(dev.id);
    await held.reached;
    const head = h.remoteHead('feat/a') as string;
    h.setGhState({
      alreadyExists: 1,
      prs: {
        '1': {
          number: 1,
          state: 'OPEN',
          headRefName: 'feat/a',
          headRefOid: head,
          baseRefName: 'main',
          author: { login: 'pact-user' },
          isCrossRepository: false,
          mergeStateStatus: 'CLEAN',
          title: 'Connexion par e-mail',
          body: '',
          ...patch,
        },
      },
    });
    return { request, head };
  }

  it('When every check passes, Then that PR is followed as the PR of the request, and no second one is made', async () => {
    const { request, head } = await crashed();

    await h.restart({ restore: false });

    const done = await h.until(request.id, ['watching'], STEP_MS);
    expect(done.pr?.number).toBe(1);
    expect(done.pr?.expectedAuthor).toBe('pact-user');
    expect(h.prHead(1)).toBe(head);
    expect(Object.keys(h.ghStateNow().prs)).toEqual(['1']);
    expect(h.deliveries()).toHaveLength(1);
  });

  it.each([
    ['another author', { author: { login: 'someone-else' } }],
    ['a fork', { isCrossRepository: true }],
    ['another head', { headRefOid: 'e'.repeat(40), frozenHead: true }],
    ['another base', { baseRefName: 'develop' }],
    ['been closed', { state: 'CLOSED' }],
  ])(
    'When the PR has %s, Then the request is refused in French with a remedy, the PR is never followed and no text of it travels',
    async (_what, patch) => {
      const { request } = await crashed({ title: WITNESS, body: WITNESS, ...patch });

      await h.restart({ restore: false });

      const refused = await h.until(request.id, ['refused'], STEP_MS);
      expect(refused.pr).toBeNull();
      expect(refused.reason).toMatch(/PR #1/);
      expect(refused.reason).not.toMatch(/already exists|pull request for branch/);
      expect(refused.reason).not.toContain(WITNESS);
      expect(JSON.stringify(h.journal())).not.toContain(WITNESS);
      expect(JSON.stringify(h.notices)).not.toContain(WITNESS);
      expect(h.mergeCalls()).toHaveLength(0);
      expect(git(h.repo, 'rev-parse', 'HEAD')).toBeTruthy();
    },
  );

  it('When gh names a PR that cannot be read, Then the request is refused in French and nothing is followed', async () => {
    const { request } = await crashed();
    h.setGhState({ alreadyExists: 77 });

    await h.restart({ restore: false });

    const refused = await h.until(request.id, ['refused'], STEP_MS);
    expect(refused.pr).toBeNull();
    expect(refused.reason).toMatch(/PR #77 existe déjà/);
    expect(refused.reason).toContain('n’a pas pu être lue');
  });
});
