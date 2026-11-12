import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeliveryHarness,
  gitEnv,
  git,
  tryGit,
  type DeliveryHarness,
} from './delivery-harness';

// 008 T062 — User Story 8, the worktrees no longer pile up (sc.1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13;
// FR-034 to FR-042; SC-010, SC-011; research R17). A repository, a bare remote, the contractual fake
// `gh`, the real services around, real worktrees on a real disk — all in a temporary folder. Nothing
// real: no network, no real `gh`, no notification, and never a worktree of this repository.
//
// RED until T065 creates `src/main/delivery/cleanup.ts` and plugs it into `DeliveryService` when the
// forge says « merged ». These tests go through the service, not through the module, so that the file
// compiles today and fails for the right reason: after the merge, the worktree is still there.
//
// THE API THESE TESTS ASSUME (the dev implements it; any change of it is a change of these tests):
//   * `agents.close(id, { removeWorktree: false })` is how PACT closes the dev and the tester at the
//     merge (T025, unchanged). The harness option `markClosed` makes the mock do what `AgentManager`
//     does to the saved workspace: the agent stays, its state is `closed`. Cleanup is NEVER done through
//     `close({ removeWorktree: true })`, which forces (spec, edge cases): the harness records each call.
//   * the cleanup runs after `delivery.state = 'merged'`, for a delivery that has a verdict, and notes
//     `delivery.cleanup`: `'pending'` (written BEFORE anything is removed, so that a restart replays it),
//     then `'done'` when every worktree it had the right to remove is gone, or `'kept'` when at least one
//     is kept. `'none'` for a delivery that never cleans (no verdict, abandoned, other author).
//   * when something is kept, `delivery.reason` says why, in words that name the cause: the path of an
//     untracked or modified file, « commit » for commits beyond the merged head, `.env…` for an ignored
//     env file, the files of the tester that the merged head lacks, the error of git when the removal
//     failed. The À faire element `worktree-kept` is derived from it (T066).
//   * what is removed: `git worktree remove <path>` WITHOUT `--force`; `git branch -D` for the dev only,
//     only if its tip is still the merged head; the branch of the tester and of the orchestrator stay.
//   * the conditions are read by `GitService.statusIgnored` (the one method of 008 R17 that sees the
//     ignored `.env*`) or `hasUncommittedChanges`, and read again just before the removal (FR-042).
//   * a restart: `resume()` replays every delivery `merged` whose `cleanup` is `'pending'`.

let h: DeliveryHarness;
let shimDir: string;
let shimLog: string;
const SHIM = process.platform !== 'win32';
const REAL_GIT = SHIM ? execFileSync('which', ['git'], { encoding: 'utf8' }).trim() : '';
// The one environment the services of the harness run git in: the shim is put in front of its PATH.
const shimEnv = gitEnv as Record<string, string | undefined>;
const originalPath = shimEnv.PATH;
const hooks = new Map<string, () => Promise<void> | void>();

/** What the tests promised never to lose: taken the moment the agents are closed, checked at the end. */
type Precious = { path: string; branch: string; head: string; files: Record<string, string> };
const snapshots: Precious[] = [];

beforeEach(async () => {
  hooks.clear();
  snapshots.length = 0;
  // A `git` in front of the real one that writes down its arguments: how the removal is done is read
  // from what git was asked, not from what the code looks like.
  if (SHIM) {
    shimDir = await mkdtemp(join(tmpdir(), 'pact-git-shim-'));
    shimLog = join(shimDir, 'calls.log');
    writeFileSync(shimLog, '');
    mkdirSync(join(shimDir, 'bin'));
    const script = join(shimDir, 'bin', 'git');
    writeFileSync(
      script,
      '#!/bin/sh\nfor a in "$@"; do printf \'%s\\037\' "$a" >> "$GIT_SHIM_LOG"; done\nprintf \'\\n\' >> "$GIT_SHIM_LOG"\nexec "$GIT_SHIM_REAL" "$@"\n',
    );
    chmodSync(script, 0o755);
    shimEnv.PATH = `${join(shimDir, 'bin')}${delimiter}${originalPath ?? ''}`;
    shimEnv.GIT_SHIM_LOG = shimLog;
    shimEnv.GIT_SHIM_REAL = REAL_GIT;
  }
  h = await createDeliveryHarness({
    pollMs: 50,
    required: ['ci'],
    markClosed: true,
    afterClose: (id) => hooks.get(id)?.(),
  });
}, 30_000);

afterEach(async () => {
  await h.dispose();
  shimEnv.PATH = originalPath;
  delete shimEnv.GIT_SHIM_LOG;
  delete shimEnv.GIT_SHIM_REAL;
  if (SHIM) await rm(shimDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const branchExists = (branch: string) =>
  tryGit(h.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== null;
/** git writes `C:/…` on Windows: compare the worktrees it lists as paths, not as text. */
const listed = () =>
  git(h.repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length).trim()));
const isListed = (path: string) => listed().includes(resolve(path));
const gone = (path: string) => !existsSync(path) && !isListed(path);
const deliveryOf = () => {
  const d = h.deliveries()[0];
  if (!d) throw new Error('no delivery saved');
  return d;
};
/** The git calls PACT made since the last `forgetCalls()`. */
const calls = (): string[][] =>
  SHIM
    ? readFileSync(shimLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\u001f').slice(0, -1))
    : [];
const forgetCalls = () => {
  if (SHIM) writeFileSync(shimLog, '');
};
const worktreeRemovals = () =>
  calls().filter((args) => args.includes('worktree') && args.includes('remove'));
const branchDeletions = () =>
  calls().filter(
    (args) =>
      args.includes('branch') && args.some((a) => a === '-D' || a === '-d' || a === '--delete'),
  );

async function ignoreRules() {
  await writeFile(join(h.repo, '.gitignore'), 'node_modules/\n.env*\n');
  git(h.repo, 'add', '.gitignore');
  git(h.repo, 'commit', '-q', '-m', 'ignore rules');
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
}

/** What the removal of the worktree at `path` would lose, in the terms of SC-010. */
function snapshotOf(path: string, branch: string): Precious {
  const lines = git(path, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')
    .split('\n')
    .filter(Boolean);
  const files: Record<string, string> = {};
  for (const line of lines) {
    const file = line.slice(3);
    if (file.startsWith('node_modules')) continue;
    if (file.endsWith('/')) continue;
    files[file] = readFileSync(join(path, file), 'utf8');
  }
  return { path, branch, head: git(path, 'rev-parse', 'HEAD'), files };
}

/** SC-010: no modified file, no untracked file, no ignored `.env*`, no commit of the snapshots is lost. */
function expectNothingLost(prHead: string) {
  for (const s of snapshots) {
    for (const [file, content] of Object.entries(s.files)) {
      const there = join(s.path, file);
      expect(existsSync(there), `${file} was lost with ${s.path}`).toBe(true);
      expect(readFileSync(there, 'utf8')).toBe(content);
    }
    const reachable =
      branchExists(s.branch) ||
      tryGit(h.repo, 'merge-base', '--is-ancestor', s.head, prHead) !== null ||
      s.head === prHead;
    expect(reachable, `the commit ${s.head.slice(0, 7)} of ${s.branch} was lost`).toBe(true);
  }
}

type Team = Awaited<ReturnType<DeliveryHarness['team']>>;

/**
 * A delivery up to the PR watched, with a `node_modules` in the worktree of the dev (ignored), then
 * the merge by Auto: the CI turns green, the forge says « merged ». `onDev` and `onTester` run when
 * PACT closes that agent, i.e. between the merge and the cleanup.
 */
async function merge({
  suffix = 'a',
  onDev,
  onTester,
  mainMoves = false,
  lead = false,
}: {
  suffix?: string;
  onDev?: (team: Team) => Promise<void> | void;
  onTester?: (team: Team) => Promise<void> | void;
  mainMoves?: boolean;
  lead?: boolean;
} = {}) {
  await ignoreRules();
  const team = await h.team(suffix);
  await mkdir(join(team.dev.worktreePath, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(team.dev.worktreePath, 'node_modules', 'pkg', 'index.js'), 'x\n');
  // The orchestrator, closed and clean: the case a naive rule would take for removable.
  if (lead) await h.setAgentState(team.lead, 'closed');
  if (mainMoves) h.pushToOrigin('main', { 'upstream.txt': 'moved\n' }, 'main moves');
  hooks.set(team.dev.id, async () => {
    await onDev?.(team);
    snapshots.push(snapshotOf(team.dev.worktreePath, team.dev.branch));
  });
  hooks.set(team.tester.id, async () => {
    await onTester?.(team);
    snapshots.push(snapshotOf(team.tester.worktreePath, team.tester.branch));
  });
  const request = await h.request(team.dev.id);
  await h.until(request.id, ['watching']);
  const head = h.prHead(1);
  forgetCalls();
  await h.setSettings({ auto: true });
  h.setChecks(head, h.GREEN);
  await h.until(request.id, ['merged']);
  return { team, id: request.id, head };
}

const cleaned = (cleanup: 'done' | 'kept') =>
  h.waitFor(() => h.deliveries()[0]?.cleanup === cleanup, `the cleanup did not end in ${cleanup}`);
/** Nothing is to happen: leave the time to a wrong cleanup to show itself. */
const quiet = () => sleep(500);

describe('sc.1, SC-011 — a clean dev on the merged head is removed, node_modules and all', () => {
  it('Given a merged PR, a closed dev that is clean on the head of the PR with a node_modules, When PACT sees the merge, Then its worktree and its local branch are gone, and nothing on disk is left (SC-011)', async () => {
    const { team, head, id } = await merge();
    await cleaned('done');

    expect(gone(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(false);
    // The commit of the PR is not lost: it is on the forge.
    expect(git(h.repo, 'rev-parse', head)).toBe(head);
    expect(h.deliveryOf(id).state).toBe('merged');
    // Closing never removes (T025); only the cleanup does.
    expect(h.closed.length).toBeGreaterThan(0);
    expect(h.closed.every((c) => !c.removeWorktree)).toBe(true);
    expectNothingLost(head);
  });

  it('Given that merge, When the cleanup runs, Then it is noted pending in the request BEFORE anything is removed, then done (a restart can replay it)', async () => {
    const { team } = await merge();
    await cleaned('done');

    // The change is told to the renderer once the write has landed: it can come just after the state.
    const told = () =>
      h.changes.flatMap((c) =>
        ((c as { deliveries?: { cleanup: string; state: string }[] }).deliveries ?? []).map(
          (d) => `${d.state}:${d.cleanup}`,
        ),
      );
    await h.waitFor(() => told().includes('merged:done'), 'the end of the cleanup was not told');
    const history = told();
    expect(history).toContain('merged:pending');
    expect(history.indexOf('merged:pending')).toBeLessThan(history.lastIndexOf('merged:done'));
    expect(gone(team.dev.worktreePath)).toBe(true);
  });

  it('Given a dev with only a node_modules of ignored files, When PACT sees the merge, Then the node_modules does not make it « not clean » (sc.10, last clause)', async () => {
    const { team } = await merge();
    await cleaned('done');

    expect(existsSync(join(team.dev.worktreePath, 'node_modules'))).toBe(false);
    expect(deliveryOf().cleanup).toBe('done');
  });
});

describe('sc.2, sc.10 — a doubt: nothing is removed, and À faire says why', () => {
  it('Given a dev with an untracked file, When PACT sees the merge, Then nothing is removed, the file is intact and the reason names it', async () => {
    const { team, head } = await merge({
      onDev: ({ dev }) => writeFile(join(dev.worktreePath, 'notes.txt'), 'à garder\n'),
    });
    await cleaned('kept');

    expect(existsSync(join(team.dev.worktreePath, 'notes.txt'))).toBe(true);
    expect(await readFile(join(team.dev.worktreePath, 'notes.txt'), 'utf8')).toBe('à garder\n');
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(deliveryOf().state).toBe('merged');
    expect(deliveryOf().reason).toContain('notes.txt');
    expectNothingLost(head);
  });

  it('Given a dev with a tracked file modified, When PACT sees the merge, Then nothing is removed and the reason names the file', async () => {
    const { team, head } = await merge({
      onDev: ({ dev }) => writeFile(join(dev.worktreePath, 'src', 'a.ts'), 'export const a = 2;\n'),
    });
    await cleaned('kept');

    expect(await readFile(join(team.dev.worktreePath, 'src', 'a.ts'), 'utf8')).toBe(
      'export const a = 2;\n',
    );
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(deliveryOf().reason).toContain('src/a.ts');
    expectNothingLost(head);
  });

  it('Given a dev with a commit more than the head of the PR, When PACT sees the merge, Then nothing is removed, the commit is still on its branch and the reason says there are commits', async () => {
    let extra = '';
    const { team, head } = await merge({
      onDev: async ({ dev }) => {
        extra = await h.commit(dev, { 'src/encore.ts': 'export const e = 1;\n' }, 'encore');
      },
    });
    await cleaned('kept');

    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(git(h.repo, 'rev-parse', team.dev.branch)).toBe(extra);
    expect(extra).not.toBe(head);
    expect(deliveryOf().reason).toMatch(/commit/i);
    expectNothingLost(head);
  });

  it('Given a dev clean but for an ignored .env, When PACT sees the merge, Then nothing is removed, the .env is intact and the reason says so (sc.10)', async () => {
    const { team, head } = await merge({
      onDev: ({ dev }) => writeFile(join(dev.worktreePath, '.env.local'), 'SECRET=1\n'),
    });
    await cleaned('kept');

    expect(await readFile(join(team.dev.worktreePath, '.env.local'), 'utf8')).toBe('SECRET=1\n');
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(deliveryOf().reason).toContain('.env');
    // The node_modules next to it is no reason; the .env alone is.
    expectNothingLost(head);
  });

  it('Given a doubt on the dev, When PACT keeps it, Then the dev is not left half done: the tester, clean and contained, is still removed on its own conditions', async () => {
    const { team } = await merge({
      onDev: ({ dev }) => writeFile(join(dev.worktreePath, 'notes.txt'), 'x\n'),
    });
    await cleaned('kept');

    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(gone(team.tester.worktreePath)).toBe(true);
  });
});

describe('sc.4 — squash: the PR and its head decide, never the ancestry', () => {
  it('Given a squash merge that leaves the branch of the dev out of main (it is not merged for git), When PACT decides, Then the dev is removed all the same', async () => {
    const { team, head } = await merge();
    await cleaned('done');

    git(h.repo, 'fetch', '-q', 'origin');
    // The proof that the ancestry would have said « not merged »: the commit of the PR is not on main.
    expect(tryGit(h.repo, 'merge-base', '--is-ancestor', head, 'origin/main')).toBeNull();
    expect(gone(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(false);
  });

  it('Given a dev whose branch IS in main by ancestry but has a commit the PR does not hold, When PACT decides, Then nothing is removed (the ancestry would have said « merged »)', async () => {
    let extra = '';
    const { team, head } = await merge({
      onDev: async ({ dev }) => {
        extra = await h.commit(dev, { 'src/encore.ts': 'export const e = 1;\n' }, 'encore');
        // main of the repository catches up with the dev, extra commit included.
        git(h.repo, 'update-ref', 'refs/heads/main', extra);
      },
    });
    await cleaned('kept');

    expect(git(h.repo, 'branch', '--merged', 'main')).toContain(team.dev.branch);
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
    expectNothingLost(head);
  });
});

describe('sc.5 — the tester: contained by the content of its tests', () => {
  it('Given a clean tester whose test files are in the merged head, When PACT sees the merge, Then its worktree is removed and its branch stays (the branch is the dev’s alone)', async () => {
    const { team } = await merge();
    await cleaned('done');

    expect(gone(team.tester.worktreePath)).toBe(true);
    expect(branchExists(team.tester.branch)).toBe(true);
  });

  it('Given a tester that wrote a test file after the request, which the merged head does not hold, When PACT sees the merge, Then its worktree is kept and the reason names the file', async () => {
    const { team, head } = await merge({
      onTester: async ({ tester }) => {
        await h.commit(tester, { 'tests/extra.test.ts': 'export const x = 1;\n' }, 'more tests');
      },
    });
    await cleaned('kept');

    expect(isListed(team.tester.worktreePath)).toBe(true);
    expect(existsSync(join(team.tester.worktreePath, 'tests', 'extra.test.ts'))).toBe(true);
    expect(deliveryOf().reason).toContain('tests/extra.test.ts');
    // The dev, for its part, was clean on the head: it goes.
    expect(gone(team.dev.worktreePath)).toBe(true);
    expectNothingLost(head);
  });

  it('Given a tester with an untracked file, When PACT sees the merge, Then it is kept (sc.2 applies)', async () => {
    const { team, head } = await merge({
      onTester: ({ tester }) => writeFile(join(tester.worktreePath, 'brouillon.txt'), 'x\n'),
    });
    await cleaned('kept');

    expect(existsSync(join(team.tester.worktreePath, 'brouillon.txt'))).toBe(true);
    expect(deliveryOf().reason).toContain('brouillon.txt');
    expectNothingLost(head);
  });

  it('Given a tester whose test file differs in content from the one of the merged head, When PACT sees the merge, Then it is kept: « contained » is read by content, not by history', async () => {
    const { team, head } = await merge({
      onTester: async ({ tester, tests }) => {
        await h.commit(tester, { [tests]: 'export const t = "autre";\n' }, 'rewrites the test');
      },
    });
    await cleaned('kept');

    expect(isListed(team.tester.worktreePath)).toBe(true);
    expect(deliveryOf().reason).toContain(team.tests);
    expectNothingLost(head);
  });
});

describe('sc.6 — the orchestrator is never touched', () => {
  it('Given a merged PR and an orchestrator closed and clean, When PACT sees the merge, Then its worktree and its branch are still there and git was never asked to remove them', async () => {
    const { team } = await merge({ lead: true });
    await cleaned('done');

    expect(existsSync(team.lead.worktreePath)).toBe(true);
    expect(isListed(team.lead.worktreePath)).toBe(true);
    expect(branchExists(team.lead.branch)).toBe(true);
    if (SHIM) {
      const touched = calls().filter((args) => args.some((a) => a === team.lead.worktreePath));
      expect(touched.filter((args) => args.includes('remove'))).toEqual([]);
      expect(branchDeletions().flat()).not.toContain(team.lead.branch);
    }
  });
});

describe('sc.7, sc.8, FR-039, FR-041 — never automatic', () => {
  /** A PR followed, the dev closed and clean on the head: all that would allow a removal, but the merge. */
  async function watchedAndRemovable() {
    await ignoreRules();
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    await h.until(request.id, ['watching']);
    await h.setAgentState(team.dev, 'closed');
    await h.setAgentState(team.tester, 'closed');
    return { team, id: request.id, head: h.prHead(1) };
  }
  const intact = (team: Team) => {
    expect(existsSync(team.dev.worktreePath)).toBe(true);
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(existsSync(team.tester.worktreePath)).toBe(true);
    expect(isListed(team.tester.worktreePath)).toBe(true);
    expect(deliveryOf().cleanup).not.toBe('done');
  };

  it('Given a PR closed on the forge without a merge, When PACT sees it, Then nothing is removed', async () => {
    const { team, id } = await watchedAndRemovable();

    h.patchPr(1, { state: 'CLOSED' });
    await h.until(id, ['closed-on-forge']);
    await quiet();

    intact(team);
    expect(deliveryOf().cleanup).toBe('none');
  });

  it('Given an agent of the delivery closed by the user, When the PR is merged by hand afterwards, Then nothing is removed (the request fell, the work is abandoned)', async () => {
    const { team, id } = await watchedAndRemovable();

    await h.delivery.agentClosed(team.dev.id);
    await h.until(id, ['dropped']);
    h.patchPr(1, { state: 'MERGED' });
    await quiet();

    intact(team);
    expect(deliveryOf().state).toBe('dropped');
  });

  it('Given a PR of another author merged on the branch of the dev, When PACT sees it, Then no removal takes place', async () => {
    const { team } = await watchedAndRemovable();

    h.patchPr(1, { author: { login: 'someone-else' }, state: 'MERGED' });
    await quiet();

    intact(team);
    expect(deliveryOf().cleanup).toBe('none');
  });

  it('Given a PR without a verdict that the user merges, When it is merged, Then nothing is removed even if the dev is closed and clean on the head (FR-039)', async () => {
    const lead = await h.addAgent('orchestrator', { branch: 'lead/u' });
    const dev = await h.addAgent('dev', { branch: 'feat/u' });
    await h.commit(dev, { 'src/u.ts': 'export const u = 1;\n' }, 'feat');
    const request = await h.request(dev.id, { unverified: true, by: 'user' });
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.setChecks(head, h.GREEN);
    await h.until(request.id, ['reviewing']);
    await h.setAgentState(dev, 'closed');

    await h.delivery.decide({ deliveryId: request.id, decision: 'validate', head });
    await h.until(request.id, ['merged']);
    await quiet();

    expect(existsSync(dev.worktreePath)).toBe(true);
    expect(isListed(dev.worktreePath)).toBe(true);
    expect(branchExists(dev.branch)).toBe(true);
    expect(existsSync(lead.worktreePath)).toBe(true);
    expect(deliveryOf().cleanup).toBe('none');
  });

  it('Given any merge, When the agents are closed, Then not a single close asks to remove a worktree: no tool of an agent deletes one (sc.9, FR-041)', async () => {
    await merge();
    await cleaned('done');

    expect(h.closed.length).toBeGreaterThan(0);
    expect(h.closed.filter((c) => c.removeWorktree)).toEqual([]);
  });
});

describe('sc.11 — a PR rebased, then merged: the dev brought to R is removed', () => {
  it('Given main moved so that PACT rebased the PR on R and brought the worktree of the dev to R, When the PR is merged, Then that worktree is removed with no « Supprimer quand même »', async () => {
    const { team, head, id } = await merge({ mainMoves: true });
    await cleaned('done');

    // The head of the PR is R, not the commit F that the dev made.
    expect(head).not.toBe(h.deliveryOf(id).frozenCommit);
    expect(h.deliveryOf(id).pushedHead).toBe(head);
    expect(gone(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(false);
    expect(deliveryOf().reason ?? '').not.toMatch(/gardé|kept/i);
    expectNothingLost(head);
  });
});

describe('sc.13, FR-042 — the conditions are read again just before the removal', () => {
  it('Given an agent reopened between the merge and the cleanup, When PACT cleans, Then nothing is removed', async () => {
    const { team, head } = await merge({
      onDev: async ({ dev }) => {
        // The user restarts the dev: it works again.
        await h.setAgentState(dev, 'working');
      },
    });
    // The tester is clean and contained: it goes, the dev back at work does not.
    await h.waitFor(() => gone(team.tester.worktreePath), 'the tester was not cleaned');
    await quiet();

    expect(existsSync(team.dev.worktreePath)).toBe(true);
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(deliveryOf().cleanup).not.toBe('done');
    expectNothingLost(head);
  });

  it('Given a file written in the worktree of the dev after the first reading of its state by the cleanup, When PACT is about to remove it, Then the file and the worktree are still there (the reading is renewed, and git refuses without --force)', async () => {
    const real = h.gitService.statusIgnored.bind(h.gitService);
    const realDirty = h.gitService.hasUncommittedChanges.bind(h.gitService);
    // Armed when PACT closes the dev at the merge: the readings of the request do not count.
    let armed = false;
    let late = false;
    const writeLate = async (cwd: string) => {
      if (!armed || late || !cwd.endsWith('agent-2')) return;
      late = true;
      await writeFile(join(cwd, 'late.txt'), 'trop tard\n');
    };
    vi.spyOn(h.gitService, 'statusIgnored').mockImplementation(async (cwd) => {
      const out = await real(cwd);
      await writeLate(cwd);
      return out;
    });
    vi.spyOn(h.gitService, 'hasUncommittedChanges').mockImplementation(async (cwd) => {
      const out = await realDirty(cwd);
      await writeLate(cwd);
      return out;
    });

    const { team } = await merge({
      onDev: () => {
        armed = true;
      },
    });
    await quiet();

    expect(late, 'the cleanup never read the worktree of the dev after the merge').toBe(true);
    expect(await readFile(join(team.dev.worktreePath, 'late.txt'), 'utf8')).toBe('trop tard\n');
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
  });

  it('Given the dev reopened after the first reading of its worktree by the cleanup, When PACT is about to remove it, Then nothing is removed (FR-042: an open agent never loses its worktree)', async () => {
    const real = h.gitService.statusIgnored.bind(h.gitService);
    let armed = false;
    let reopened = false;
    vi.spyOn(h.gitService, 'statusIgnored').mockImplementation(async (cwd) => {
      const out = await real(cwd);
      if (armed && !reopened && cwd.endsWith('agent-2')) {
        reopened = true;
        const dev = h.workspace().agents.find((a) => a.worktreePath === cwd);
        if (dev) await h.setAgentState(dev, 'working');
      }
      return out;
    });

    const { team } = await merge({
      onDev: () => {
        armed = true;
      },
    });
    await quiet();

    expect(reopened, 'the cleanup never read the worktree of the dev after the merge').toBe(true);
    expect(existsSync(team.dev.worktreePath)).toBe(true);
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
  });
});

describe('a removal that fails, a restart', () => {
  it.skipIf(!SHIM)(
    'Given a worktree that git cannot remove (locked, as a terminal open in it would), When PACT cleans, Then it does not force: the worktree and the branch stay, and the reason carries the error of git',
    async () => {
      const { team, head } = await merge({
        onDev: ({ dev }) => {
          git(h.repo, 'worktree', 'lock', '--reason', 'terminal ouvert', dev.worktreePath);
        },
      });
      await cleaned('kept');

      expect(existsSync(team.dev.worktreePath)).toBe(true);
      expect(isListed(team.dev.worktreePath)).toBe(true);
      expect(branchExists(team.dev.branch)).toBe(true);
      expect(deliveryOf().reason).toContain('terminal ouvert');
      expect(
        worktreeRemovals().some((args) => args.includes('--force') || args.includes('-f')),
      ).toBe(false);
      expectNothingLost(head);
    },
  );

  /** PACT stopped between the merge and the cleanup: merged on the forge, `cleanup: pending` on the disk. */
  async function interrupted(prepare: (team: Team) => void | Promise<void> = () => undefined) {
    await ignoreRules();
    const team = await h.team('a');
    const request = await h.request(team.dev.id);
    await h.until(request.id, ['watching']);
    const head = h.prHead(1);
    h.delivery.dispose();
    h.patchPr(1, { state: 'MERGED' });
    await h.setAgentState(team.dev, 'closed');
    await h.setAgentState(team.tester, 'closed');
    await h.workspaces.update(h.workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) => ({ ...d, state: 'merged', cleanup: 'pending' })),
      loops: ws.loops.map((l) => ({ ...l, state: 'merged' })),
    }));
    await prepare(team);
    return { team, head, id: request.id };
  }

  it('Given PACT restarted with a delivery merged and cleanup pending, When it resumes, Then the cleanup is replayed: the worktrees are removed and it is done', async () => {
    const { team, head } = await interrupted();

    await h.restart();
    await cleaned('done');

    expect(gone(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(false);
    expect(gone(team.tester.worktreePath)).toBe(true);
    expectNothingLost(head);
  });

  it('Given the same restart with the worktree of the dev already gone (properly removed, or the folder deleted by hand), When PACT resumes, Then it is not an error: the cleanup ends done, nothing is said as a failure', async () => {
    const { team } = await interrupted((t) => {
      git(h.repo, 'worktree', 'remove', t.dev.worktreePath);
    });

    await h.restart();
    await cleaned('done');

    expect(gone(team.dev.worktreePath)).toBe(true);
    expect(deliveryOf().reason ?? '').toBe('');
    expect(h.deliveryMessages().filter((m) => m.delivery?.outcome === 'alert')).toEqual([]);
  });

  it('Given the same restart with the folder of the dev deleted behind git’s back, When PACT resumes, Then it ends done too, and the branch of the dev, still the merged head, goes', async () => {
    const { team } = await interrupted(async (t) => {
      await rm(t.dev.worktreePath, { recursive: true, force: true });
    });

    await h.restart();
    await cleaned('done');

    expect(existsSync(team.dev.worktreePath)).toBe(false);
    expect(deliveryOf().reason ?? '').toBe('');
  });

  it('Given a restart where the dev was reopened meanwhile, When PACT resumes, Then the conditions are read again: nothing is removed', async () => {
    const { team } = await interrupted(async (t) => {
      await h.setAgentState(t.dev, 'working');
    });

    await h.restart();
    await quiet();

    expect(existsSync(team.dev.worktreePath)).toBe(true);
    expect(isListed(team.dev.worktreePath)).toBe(true);
    expect(branchExists(team.dev.branch)).toBe(true);
    expect(deliveryOf().cleanup).not.toBe('done');
  });
});

describe.skipIf(!SHIM)('how it deletes (FR-036, R17): what git was asked', () => {
  it('Given a clean dev and a clean tester, When PACT cleans, Then git was asked `worktree remove <path>` for each, never with --force, and for nothing else', async () => {
    const { team } = await merge({ lead: true });
    await cleaned('done');

    const removals = worktreeRemovals();
    const targets = removals.map((args) => args.at(-1));
    expect(targets).toContain(team.dev.worktreePath);
    expect(targets).toContain(team.tester.worktreePath);
    expect(targets).not.toContain(team.lead.worktreePath);
    expect(removals.flat()).not.toContain('--force');
    expect(removals.flat()).not.toContain('-f');
    // Nothing else in the `worktree` family removes by force either.
    expect(calls().filter((args) => args.includes('worktree') && args.includes('--force'))).toEqual(
      [],
    );
  });

  it('Given that cleanup, When the branches are deleted, Then only the branch of the dev is, and the decision never asked git whether a branch is merged', async () => {
    const { team } = await merge({ lead: true });
    await cleaned('done');

    const deleted = branchDeletions().flatMap((args) => args.filter((a) => !a.startsWith('-')));
    const names = deleted.filter((a) => a !== 'branch' && a !== 'core.quotePath=false');
    expect(names).toContain(team.dev.branch);
    expect(names).not.toContain(team.tester.branch);
    expect(names).not.toContain(team.lead.branch);
    expect(names).not.toContain('main');
    expect(
      calls().filter((args) => args.some((a) => a === '--merged' || a === '--no-merged')),
    ).toEqual([]);
  });

  it('Given a dev whose tip is no longer the merged head, When PACT cleans, Then git was asked to delete no branch and to remove no worktree of the dev', async () => {
    const { team } = await merge({
      onDev: async ({ dev }) => {
        await h.commit(dev, { 'src/encore.ts': 'export const e = 1;\n' }, 'encore');
      },
    });
    await cleaned('kept');

    expect(worktreeRemovals().map((args) => args.at(-1))).not.toContain(team.dev.worktreePath);
    expect(branchDeletions().flat()).not.toContain(team.dev.branch);
  });
});

describe('R17 — when the forge cannot say which head was merged', () => {
  const keptWithNotes = async () => {
    const merged = await merge({
      onDev: ({ dev }) => writeFile(join(dev.worktreePath, 'notes.txt'), 'à garder\n'),
    });
    await cleaned('kept');
    return merged;
  };

  it('Given a forge that is down, When what would be lost is asked, Then PACT’s own record of the pushed head is used and the file is listed', async () => {
    const { team, id } = await keptWithNotes();
    h.setGhState({ forgeDown: true });

    const lost = await h.delivery.worktreeCleanup.lost(id, team.dev.id);

    expect(lost).toEqual(['notes.txt (non suivi)']);
  });

  it('Given a forge that answers an empty head, When what would be lost is asked, Then the pushed head is used too', async () => {
    const { team, id } = await keptWithNotes();
    h.patchPr(1, { headRefOid: '' });

    const lost = await h.delivery.worktreeCleanup.lost(id, team.dev.id);

    expect(lost).toEqual(['notes.txt (non suivi)']);
  });

  it('Given a request with no PR recorded, When what would be lost is asked, Then the pushed head is used without asking the forge', async () => {
    const { team, id } = await keptWithNotes();
    const workspaceId = h.workspace().id;
    await h.workspaces.update(workspaceId, (ws) => ({
      ...ws,
      deliveries: ws.deliveries.map((d) => (d.id === id ? { ...d, pr: null } : d)),
    }));
    h.setGhState({ forgeDown: true });

    const lost = await h.delivery.worktreeCleanup.lost(id, team.dev.id);

    expect(lost).toEqual(['notes.txt (non suivi)']);
  });

  it('Given a PR that cannot be read or does not exist, When its author is checked, Then it is not PACT’s own: nothing may be cleaned', async () => {
    const { id } = await keptWithNotes();
    const service = h.delivery as unknown as {
      isOwnPr(workspaceId: string, d: unknown): Promise<boolean>;
    };
    const d = h.deliveryOf(id);

    expect(await service.isOwnPr(h.workspace().id, { ...d, pr: null })).toBe(false);
    expect(await service.isOwnPr(h.workspace().id, d)).toBe(true);
    h.setGhState({ forgeDown: true });
    expect(await service.isOwnPr(h.workspace().id, d)).toBe(false);
  });
});
