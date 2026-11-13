import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { LoopService } from '../../../src/main/orchestrator/loop-service';
import type { Issue } from '../../../src/shared/model';
import type { HandoffReport } from '../../../src/shared/report';
import { callTool, createHarness, git, gitEnv, type Harness } from './harness';

// 004 T020–T021 — submit_report, start_loop, next_round and get_loop with real repositories and
// fake agents: the report reaches the orchestrator, a turn without one is told, and the issue is
// done only once PACT's own run of the tests passes (FR-017 to FR-019).

let h: Harness;
let token: string;
let devId: string;
let testId: string;

const issue = (state: Issue['state']): Issue => ({
  id: '0012-connexion',
  title: 'Connexion',
  path: '.pact/issues/0012-connexion.md',
  state,
  remote: null,
  trace: { branch: null, agents: [], pr: null },
});

const setIssue = (state: Issue['state']) =>
  h.workspaces.update(h.workspace.id, (ws) => ({
    ...ws,
    issues: [issue(state)],
    testCommand: 'git --version',
  }));

beforeEach(async () => {
  h = await createHarness();
  const register = h.hooks.registerMcp.bind(h.hooks);
  vi.spyOn(h.hooks, 'registerMcp').mockImplementation((id, handler) => {
    const issued = register(id, handler);
    token ||= issued;
    return issued;
  });
  token = '';
  await h.launch([h.draft({ orchestrator: true })]);
  const [dev] = await h.launch([h.draft({ role: 'dev' })]);
  const [test] = await h.launch([h.draft({ role: 'test' })], 'role-report');
  devId = dev?.id ?? '';
  testId = test?.id ?? '';
  await setIssue('ready');
}, 30_000);

afterEach(async () => {
  await h.dispose();
});

const tool = (name: string, args: Record<string, unknown> = {}) =>
  callTool(h.hooks.mcpUrl(), token, name, args);

const current = () => h.workspaces.get(h.workspace.id);

describe('start_loop', () => {
  it('is refused for an issue not ready, or agents without the dev and test roles', async () => {
    await setIssue('proposed');
    const notReady = await tool('start_loop', {
      issue: '0012-connexion',
      dev: devId,
      test: testId,
    });
    expect(notReady).toMatchObject({ isError: true });
    expect(notReady.text).toBe('L’issue 0012-connexion n’est pas prête (proposed).');

    await setIssue('ready');
    const swapped = await tool('start_loop', { issue: '0012-connexion', dev: testId, test: devId });
    expect(swapped.text).toBe('Il faut un agent dev et un agent test.');
    expect(h.actionsHeard.map((a) => [a.tool, a.outcome])).toEqual([
      ['start_loop', 'refused'],
      ['start_loop', 'refused'],
    ]);
  });
});

describe('a loop', () => {
  it('goes round on defects, then is accepted once PACT’s run of the tests passes (the issue is done at the merge, 008 FR-007)', async () => {
    const started = await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    expect(started.isError).toBe(false);
    expect(started.text).toContain('Boucle de 0012-connexion démarrée : tour 1/3.');
    expect(started.text).toMatch(/consigne/i);
    expect(current()?.issues[0]).toMatchObject({ state: 'in-progress' });

    // Round 1: the test finds a defect and reports it with submit_report.
    await tool('send_prompt', { agent: testId, text: '0012-connexion' });
    // The wake groups messages for 5 s (WAKE_GROUP_MS): deliver it now, the test is not about that wait.
    h.wake?.deliver(testId);
    await h.waitFor(() => h.reports.some((r) => r.kind === 'report'), 'no report heard');
    const heard = Date.now();
    const { text, json } = await tool('wait_for_agents', { agents: [testId], timeoutSeconds: 10 });
    expect((json as { events: { kind: string }[] }).events.map((e) => e.kind)).toContain('report');
    expect(text).toContain('a rendu son rapport : Le test échoue');
    expect(Date.now() - heard).toBeLessThan(1000);
    expect(current()?.loops[0]?.rounds[0]?.reports[0]).toMatchObject({
      agentId: testId,
      role: 'test',
      verdict: { result: 'defects' },
    });

    const next = await tool('next_round', { issue: '0012-connexion' });
    expect(next.text).toBe('0012-connexion : tour 2/3.');

    // Round 2: accepted; the loop is accepted only on PACT's own run of the tests.
    await h.waitFor(
      () => ['done', 'awaiting-prompt'].includes(h.current(testId)?.state ?? ''),
      'the test is still working',
      testId,
    );
    await tool('send_prompt', { agent: testId, text: '0012-connexion' });
    // The wake groups messages for 5 s (WAKE_GROUP_MS): deliver it now, the test is not about that wait.
    h.wake?.deliver(testId);
    await h.waitFor(() => current()?.loops[0]?.state === 'accepted', 'loop not accepted', testId);
    expect(current()?.issues[0]?.state).toBe('in-progress');
    const loop = await tool('get_loop', { issue: '0012-connexion' });
    expect(loop.text).toBe('0012-connexion : tour 2/3, accepted.');
    expect(current()?.loops[0]?.rounds[1]?.proof).toMatchObject({ exitCode: 0 });
    // Earlier events of the dev (its turn ending) can come first: read until the proof arrives.
    const proof = '0012-connexion : tests passés par PACT au tour 2.';
    let proved = '';
    for (let i = 0; i < 5 && !proved.includes(proof); i++) {
      proved += (await tool('wait_for_agents', { agents: [devId], timeoutSeconds: 5 })).text;
    }
    expect(proved).toContain(proof);
  }, 30_000);

  it('lets a run of the tests go when the worktree of the dev is already gone: no rejection, no proof (#132)', async () => {
    // Given a loop started and a passing run of the tests of the dev, still to be told to the loop
    await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    const worktree = h.current(devId)?.worktreePath ?? '';
    const { tree } = await new GitService({ env: gitEnv }).snapshot(worktree);
    const run = {
      agentId: devId,
      command: 'git --version',
      tree,
      status: 'passed' as const,
      passedCount: null,
      outputTail: '',
    };
    // When the cleanup removes the worktree while the agent is still listed (closeOne removes the
    // worktree first), and the run reports after it
    git(h.repo, 'worktree', 'remove', '--force', worktree);
    // Then the loop lets the run go: it is fire and forget in the app, a rejection would be unhandled
    await h.loops.testRun(run);
    expect(current()?.loops[0]?.rounds[0]?.proof).toBeNull();
  }, 30_000);

  it('escalates the dev to its ceiling, in the same session (FR-007)', async () => {
    await h.manager.escalate(devId, 'fake-large');
    expect(h.current(devId)?.model).toBe('fake-large');
    await h.waitForState(devId, 'awaiting-prompt');
    // Already on it: nothing restarts.
    const events = h.events.length;
    await h.manager.escalate(devId, 'fake-large');
    expect(h.events.length).toBe(events);
  }, 30_000);

  it('tells the orchestrator when an agent ends its turn without a report', async () => {
    await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    await tool('send_prompt', { agent: devId, text: 'Écris la connexion' });
    await h.waitFor(() => h.reports.some((r) => r.kind === 'report-missing'), 'not told', devId);
    const { text } = await tool('wait_for_agents', { agents: [devId], timeoutSeconds: 10 });
    expect(text).toContain('a fini son tour sans rapport.');
    expect(current()?.loops[0]?.round).toBe(1);
  }, 30_000);

  it('refuses next_round before a defects verdict, and get_loop without a loop', async () => {
    expect((await tool('get_loop', { issue: '0012-connexion' })).text).toBe(
      'Aucune boucle pour 0012-connexion.',
    );
    await tool('start_loop', { issue: '0012-connexion', dev: devId, test: testId });
    const early = await tool('next_round', { issue: '0012-connexion' });
    expect(early).toMatchObject({ isError: true });
    expect(early.text).toBe('Le tour 1 attend le verdict « defects » du test.');
  });
});

// 007 US4 (T050, FR-023, R12) — the check of the files the tester changed starts from the real base of
// its branch, worked out at each verdict, on temporary Git repositories: a tester put back on `main`
// (or on an `origin/main` that moved) is accepted, a production file is rejected with the way out,
// the merge of the dev's branch is rejected, a restart of PACT keeps the check, and an explicit
// `baseBranch` is respected.
describe('the control of the files of the tester (007 FR-023)', () => {
  const ID = '0012-connexion';
  const verdict = (result: 'accepted' | 'defects' = 'accepted'): HandoffReport => ({
    issue: ID,
    status: result === 'accepted' ? 'done' : 'defects',
    summary: 'Verdict',
    files: [],
    checks: [{ command: 'git --version', exitCode: 0 }],
    questions: [],
    verdict: { result, defects: result === 'accepted' ? [] : ['Un défaut'] },
  });
  const worktree = (id: string) => h.current(id)?.worktreePath ?? '';
  const commit = async (cwd: string, path: string, message: string) => {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), `// ${message}\n`);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', message);
  };
  const startLoop = () => h.loops.start(h.workspace.id, { issue: ID, dev: devId, test: testId });
  const touched = () => current()?.loops[0]?.rounds[0]?.testerTouched;

  it('accepts a tester that changed only tests, then was put back on main that moved (US4 sc.2, SC-006)', async () => {
    // Given a loop started, a tester that wrote a test and a main that moved on
    await startLoop();
    await commit(worktree(testId), 'tests/connexion.test.ts', 'tests du testeur');
    await commit(h.repo, 'src/auth.ts', 'main avance');
    // When the tester is put back on main, then gives its verdict
    git(worktree(testId), 'rebase', 'main');
    const rejection = await h.loops.report(testId, verdict());
    // Then PACT accepts it: the files that came from main are not the tester's
    expect(rejection).toBeNull();
    expect(touched()).toEqual([]);
  }, 30_000);

  it('accepts it too when put back on an origin/main that moved while main stayed behind (SC-006)', async () => {
    // Given a remote, a local main behind origin/main and a tester put back on origin/main
    const remote = join(h.root, 'origin.git');
    git(h.root, 'init', '--bare', '-b', 'main', remote);
    git(h.repo, 'remote', 'add', 'origin', remote);
    git(h.repo, 'push', 'origin', 'main');
    await startLoop();
    await commit(worktree(testId), 'tests/connexion.test.ts', 'tests du testeur');
    const other = join(h.root, 'other');
    git(h.root, 'clone', remote, other);
    await commit(other, 'src/upstream.ts', 'origin/main avance');
    git(other, 'push', 'origin', 'main');
    git(h.repo, 'fetch', 'origin');
    git(worktree(testId), 'rebase', 'origin/main');
    // When it gives its verdict
    const rejection = await h.loops.report(testId, verdict());
    // Then it is accepted, whichever of the two bases is behind
    expect(rejection).toBeNull();
    expect(touched()).toEqual([]);
  }, 30_000);

  it('rejects a verdict after a production file, with the list and the way out (US4 sc.3)', async () => {
    // Given a tester that changed a test and a production file
    await startLoop();
    await commit(worktree(testId), 'tests/connexion.test.ts', 'tests du testeur');
    await mkdir(join(worktree(testId), 'src'), { recursive: true });
    await writeFile(join(worktree(testId), 'src', 'oops.ts'), '// prod\n');
    // When it gives its verdict
    const rejection = await h.loops.report(testId, verdict());
    // Then it is rejected: the file is named, the test is not, and the message says to remove it from the branch
    expect(rejection).toContain('src/oops.ts');
    expect(rejection).not.toContain('tests/connexion.test.ts');
    expect(rejection).toMatch(/retire/i);
    expect(rejection).toMatch(/branche/i);
    expect(touched()).toEqual(['src/oops.ts']);
  }, 30_000);

  it('rejects a verdict after the merge of the branch of the dev (R12)', async () => {
    // Given a dev that committed production code, and a tester that merged its branch
    await startLoop();
    await commit(worktree(devId), 'src/connexion.ts', 'le code du dev');
    await commit(worktree(testId), 'tests/connexion.test.ts', 'tests du testeur');
    git(worktree(testId), 'merge', '--no-edit', h.current(devId)?.branch ?? '');
    // When the tester gives its verdict
    const rejection = await h.loops.report(testId, verdict());
    // Then it is rejected with the dev's file, and the way out
    expect(rejection).toContain('src/connexion.ts');
    expect(rejection).toMatch(/retire/i);
    expect(touched()).toContain('src/connexion.ts');
  }, 30_000);

  it('keeps the check after a restart of PACT: a new LoopService reads the real base (US4 sc.4)', async () => {
    // Given a loop started by a first LoopService, and a tester that changed a production file
    await startLoop();
    await commit(worktree(testId), 'src/oops.ts', 'code de prod');
    // When PACT restarts (a new LoopService, nothing in memory) and the tester gives its verdict
    const restarted = new LoopService({
      workspaces: h.workspaces,
      git: new GitService({ env: gitEnv }),
      review: h.review,
      tests: h.tests,
      agents: { escalate: () => Promise.resolve() },
      notify: () => undefined,
      message: (workspaceId: string, draft: never) => h.exchanges?.record(workspaceId, draft),
    } as never);
    const rejection = await restarted.report(testId, verdict());
    // Then the check still takes place
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('src/oops.ts');
    expect(touched()).toEqual(['src/oops.ts']);
  }, 30_000);

  it('respects an explicit baseBranch: a tester started from another branch is not blamed for its files (US4 sc.7)', async () => {
    // Given a branch `feature` ahead of main, and a tester launched from it
    git(h.repo, 'checkout', '-b', 'feature');
    await commit(h.repo, 'src/feature.ts', 'la branche feature');
    git(h.repo, 'checkout', 'main');
    const [other] = await h.launch(
      [h.draft({ role: 'test', baseBranch: 'feature' })],
      'role-report',
    );
    const otherId = other?.id ?? '';
    await h.workspaces.update(h.workspace.id, (ws) => ({
      ...ws,
      issues: [
        ...ws.issues,
        { ...issue('ready'), id: '0013-autre', path: '.pact/issues/0013-autre.md' },
      ],
    }));
    await h.loops.start(h.workspace.id, { issue: '0013-autre', dev: devId, test: otherId });
    await commit(worktree(otherId), 'tests/autre.test.ts', 'tests du testeur');
    // When it gives its verdict
    const rejection = await h.loops.report(otherId, { ...verdict(), issue: '0013-autre' });
    // Then it is accepted: src/feature.ts comes from its base, not from the tester
    expect(h.current(otherId)?.baseBranch).toBe('feature');
    expect(rejection).toBeNull();
  }, 30_000);
});
