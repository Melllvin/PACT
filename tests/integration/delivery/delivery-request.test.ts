import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isFinalState } from '../../../src/shared/delivery';
import { createDeliveryHarness, git, ISSUE, short, type DeliveryHarness } from './delivery-harness';

// 008 T012 — the request of a delivery and its barriers (US1 sc.1 to 4, FR-002, FR-003, FR-004,
// FR-007; contracts/mcp-tools.md « request_delivery »; research R4, R6). A repository, a bare
// remote, the contractual fake `gh`: nothing real.
//
// RED until DeliveryService exists (T018). The API assumed is in delivery-harness.ts.

let h: DeliveryHarness;

beforeEach(async () => {
  h = await createDeliveryHarness();
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

/** No branch of the delivery reached the remote, no PR was asked for. */
const nothingLeft = (branch: string) => {
  expect(h.remoteHead(branch)).toBeNull();
  expect(h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create')).toEqual([]);
};

describe('the barriers of the request', () => {
  it('Given a loop without the verdict accepted, When delivery is requested, Then it is refused with its reason and nothing is pushed (sc.1)', async () => {
    const { dev, tester } = await h.team('a', { accept: false });
    await h.acceptLoop(dev, tester, { state: 'running' });

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toBe(`La boucle de ${ISSUE} n’est pas acceptée (running).`);
    expect(isFinalState(h.deliveryOf(delivery.id).state)).toBe(true);
    nothingLeft(dev.branch);
  });

  it('Given an agent without any loop, When delivery is requested, Then it is refused (the PR without a verdict is another gesture)', async () => {
    const dev = await h.addAgent('dev', { branch: 'feat/seul' });
    await h.commit(dev, { 'src/seul.ts': 'export const s = 1;\n' });

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toContain('n’est pas acceptée');
    nothingLeft(dev.branch);
  });

  it('Given a verdict on another commit than the head, When delivery is requested, Then it is refused naming both commits (sc.2)', async () => {
    const { dev, tester } = await h.team('a', { accept: false });
    const judged = git(dev.worktreePath, 'rev-parse', 'HEAD');
    await h.acceptLoop(dev, tester);
    const head = await h.commit(
      dev,
      { 'src/apres.ts': 'export const x = 1;\n' },
      'after the verdict',
    );

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toBe(
      `Le verdict porte sur ${short(judged)}, la tête est ${short(head)}.`,
    );
    nothingLeft(dev.branch);
  });

  it('Given PACT’s proof on another commit than the head, When delivery is requested, Then it is refused (sc.2)', async () => {
    const { dev, tester } = await h.team('a', { accept: false });
    const before = git(dev.worktreePath, 'rev-parse', 'HEAD');
    const head = await h.commit(dev, { 'src/plus.ts': 'export const p = 1;\n' }, 'more');
    await h.acceptLoop(dev, tester, { proofCommit: before });

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toBe(`Les tests de PACT n’ont pas validé ${short(head)}.`);
    nothingLeft(dev.branch);
  });

  it('Given changes that are not committed, When delivery is requested, Then it is refused and lists the files (sc.2)', async () => {
    const { dev } = await h.team('a');
    await writeFile(join(dev.worktreePath, 'src', 'brouillon.ts'), 'export const b = 1;\n');
    await writeFile(join(dev.worktreePath, 'README.md'), '# modifié\n');

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toContain('Changements non commités');
    expect(delivery.reason).toContain('src/brouillon.ts');
    expect(delivery.reason).toContain('README.md');
    nothingLeft(dev.branch);
  });

  it('Given tests of the tester missing from the dev’s branch, When delivery is requested, Then the reason lists the files and the dev gets the way to fetch them (sc.3, FR-002, R4)', async () => {
    const { lead, dev, tester } = await h.team('a');
    await h.commit(tester, { 'tests/b.test.ts': 'export const b = 1;\n' }, 'more tests');
    // The tester’s verdict is on the dev’s head; only its tests are missing from the dev’s branch.

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toContain('Tests du testeur manquants');
    expect(delivery.reason).toContain('tests/b.test.ts');
    expect(delivery.reason).not.toContain('tests/a.test.ts');
    // « Consigne envoyée au dev »: by git, from the tester’s branch, then a commit.
    const toDev = h.messagesTo(dev.id).filter((m) => m.from === 'pact');
    const instruction = toDev.at(-1)?.text ?? '';
    expect(instruction).toContain(`git checkout ${tester.branch} -- tests/b.test.ts`);
    expect(instruction).toMatch(/commit/i);
    expect(h.messagesTo(lead.id).some((m) => m.from === 'pact')).toBe(true);
    nothingLeft(dev.branch);
  });

  it('Given a test file that differs between the tester and the dev, When delivery is requested, Then it is refused: the content must be identical (Q13)', async () => {
    const { dev, tester } = await h.team('a');
    await h.commit(tester, { 'tests/a.test.ts': 'export const t = "autre";\n' }, 'tests changed');

    const delivery = await h.request(dev.id);

    expect(delivery.state).toBe('refused');
    expect(delivery.reason).toContain('tests/a.test.ts');
    nothingLeft(dev.branch);
  });

  it('Given every barrier passed, When delivery is requested, Then the request freezes the head F and goes on without a refusal', async () => {
    const { dev, tester } = await h.team('a');
    const frozen = git(dev.worktreePath, 'rev-parse', 'HEAD');

    const delivery = await h.request(dev.id);

    expect(delivery.state).not.toBe('refused');
    expect(delivery.frozenCommit).toBe(frozen);
    expect(delivery.agentId).toBe(dev.id);
    expect(delivery.testAgentId).toBe(tester.id);
    expect(delivery.issueId).toBe('001a-a');
    expect(delivery.branch).toBe('feat/a');
    expect(delivery.target).toBe('main');
    expect(delivery.channel).toBe('github');
    expect(delivery.pactCommits).toContain(frozen);
    expect(delivery.title).toBe('Connexion par e-mail');
    expect(delivery.requestedBy).toBe('orchestrator');
    await h.until(delivery.id, ['watching']);
  });

  it('Given a refusal, When it is saved, Then the orchestrator is told once, with the reason (FR-006)', async () => {
    const { lead, dev, tester } = await h.team('a', { accept: false });
    await h.acceptLoop(dev, tester, { state: 'running' });

    const delivery = await h.request(dev.id);

    const told = h.deliveryMessages();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      from: 'pact',
      to: lead.id,
      about: dev.id,
      type: 'action',
      delivery: { id: delivery.id, outcome: 'refused' },
    });
    expect(told[0]?.text).toBe(`Livraison refusée · ${ISSUE} · ${delivery.reason ?? ''}`);
  });
});

describe('a commit that PACT did not make', () => {
  it('Given an accepted request, When the dev adds a commit before the PR, Then the request drops, nothing is pushed and the orchestrator wakes with the reason (sc.4, R6)', async () => {
    const { lead, dev } = await h.team('a');
    const hold = h.holdTests();
    const delivery = await h.request(dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the tests of PACT never started');
    const foreign = await h.commit(dev, { 'src/en-plus.ts': 'export const z = 1;\n' }, 'one more');

    hold.release();
    const dropped = await h.until(delivery.id, ['dropped']);

    expect(dropped.reason).toContain(short(foreign));
    expect(dropped.pr).toBeNull();
    nothingLeft(dev.branch);
    const told = h.deliveryMessages();
    expect(told.map((m) => m.delivery?.outcome)).toEqual(['dropped']);
    expect(told[0]).toMatchObject({ to: lead.id, about: dev.id, type: 'action' });
    expect(told[0]?.text).toContain('Livraison tombée · 001a-a');
    expect(told[0]?.text).toContain(short(foreign));
  });

  it('Given a dropped request, When the loop is read, Then it runs again on the same round with no round counted (R6)', async () => {
    const { dev } = await h.team('a');
    const hold = h.holdTests();
    const delivery = await h.request(dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the tests of PACT never started');
    // While the request runs, the loop waits for the merge, the issue is not done (FR-007).
    expect(h.workspace().loops[0]?.state).toBe('delivering');
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
    await h.commit(dev, { 'src/en-plus.ts': 'export const z = 1;\n' }, 'one more');

    hold.release();
    await h.until(delivery.id, ['dropped']);

    const loop = h.workspace().loops[0];
    expect(loop?.state).toBe('running');
    expect(loop?.round).toBe(1);
    expect(loop?.rounds).toHaveLength(1);
    expect(h.workspace().issues[0]?.state).toBe('in-progress');
  });
});

describe('one request at a time', () => {
  it('Given a request that is not final, When the same dev is requested again, Then it is refused naming the state of the first', async () => {
    const { dev } = await h.team('a');
    const hold = h.holdTests();
    const first = await h.request(dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the tests of PACT never started');

    const second = await h.request(dev.id);

    expect(second.state).toBe('refused');
    expect(second.reason).toBe('Une livraison est déjà en cours (testing).');
    expect(h.deliveries().filter((d) => d.agentId === dev.id && !isFinalState(d.state))).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
    hold.release();
    await h.until(first.id, ['watching']);
  });

  it('Given a request that ended, When the same dev is requested again, Then the new request is not refused for the old one', async () => {
    const { dev } = await h.team('a');
    await writeFile(join(dev.worktreePath, 'brouillon.ts'), 'export const b = 1;\n');
    const first = await h.request(dev.id);
    expect(first.state).toBe('refused');
    await rm(join(dev.worktreePath, 'brouillon.ts'));

    const second = await h.request(dev.id);

    expect(second.state).not.toBe('refused');
    await h.until(second.id, ['watching']);
  });
});

describe('two requests at once', () => {
  it('Given two requests of the same dev at the same time, When both pass the barriers, Then only one runs and the other is refused naming the first', async () => {
    const { dev } = await h.team('a');

    const [one, two] = await Promise.all([h.request(dev.id), h.request(dev.id)]);

    const refused = [one, two].filter((d) => d.state === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatch(/^Une livraison est déjà en cours/);
    const kept = one.state === 'refused' ? two : one;
    await h.until(kept.id, ['watching']);
    expect(h.ghLog().filter((args) => args[0] === 'pr' && args[1] === 'create')).toHaveLength(1);
  });
});

describe('a request after a pull request that failed to open', () => {
  it('Given a branch pushed by PACT whose PR failed to open, When the dev delivers a new commit, Then PACT pushes over its own push and opens the PR', async () => {
    const { dev, tester } = await h.team('a');
    h.setGhState({ failures: { prCreate: ['HTTP 502 forge down'] } });
    const first = await h.request(dev.id);
    await h.until(first.id, ['refused']);
    expect(h.remoteHead(dev.branch)).toBeTruthy();
    await h.commit(dev, { 'src/more.ts': 'export const m = 1;\n' }, 'fix after');
    await h.workspaces.update(h.workspace().id, (ws) => ({ ...ws, loops: [] }));
    await h.acceptLoop(dev, tester);

    const second = await h.request(dev.id);

    await h.until(second.id, ['watching']);
  });
});

describe('a queue per project', () => {
  it('Given two requests of the same project, When they run, Then the second waits for the first to leave its local steps', async () => {
    const one = await h.team('a');
    const two = await h.team('b');
    const hold = h.holdTests();

    const first = await h.request(one.dev.id);
    const second = await h.request(two.dev.id);
    await h.waitFor(() => h.testRuns.length === 1, 'the first never reached its tests');
    // Give the second a fair chance to jump the queue.
    await new Promise((r) => setTimeout(r, 300));

    expect(h.testRuns).toHaveLength(1);
    expect(h.deliveryOf(first.id).state).toBe('testing');
    expect(['checking', 'syncing']).toContain(h.deliveryOf(second.id).state);
    expect(h.remoteHead(two.dev.branch)).toBeNull();

    hold.release();
    await h.until(first.id, ['watching']);
    await h.until(second.id, ['watching']);
    const opened = h.ghLog().filter(([a, b]) => a === 'pr' && b === 'create');
    expect(opened).toHaveLength(2);
    // One after the other: the PR of the first has the lower number.
    const prs = h.ghStateNow().prs;
    expect(
      Object.values(prs).find((p) => p.headRefOid === h.remoteHead(one.dev.branch))?.number,
    ).toBe(1);
    expect(
      Object.values(prs).find((p) => p.headRefOid === h.remoteHead(two.dev.branch))?.number,
    ).toBe(2);
  });
});
