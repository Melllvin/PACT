import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCleanup } from '../../../src/main/delivery/cleanup';
import { GitService } from '../../../src/main/git/git-service';
import { DEFAULT_TEST_PATHS } from '../../../src/shared/model';

// 008 US8 (R17, FR-037 to FR-042) — « Supprimer quand même » and « Garder » against a REAL git repository:
// what is lost is read from the disk, the forced removal deletes exactly the one dev worktree and its
// branch, and the delivery is settled. Only temporary repositories are touched.

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const present = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const DELIVERY = 'd0000000-0000-4000-8000-000000000001';
const DEV = 'a0000000-0000-4000-8000-000000000001';
const TESTER = 'a0000000-0000-4000-8000-000000000002';
const ORCH = 'a0000000-0000-4000-8000-000000000003';
const OTHER = 'a0000000-0000-4000-8000-000000000004';

type Fixture = {
  root: string;
  repo: string;
  cleanup: WorktreeCleanup;
  save: ReturnType<typeof vi.fn>;
  delivery: Record<string, unknown> & { kept: { agentId: string; reason: string }[] };
  agents: Record<string, Record<string, unknown>>;
  merged: { head: string | null; fail: boolean };
  workspace: { mainBranch: string };
  path: (name: string) => string;
};

let fx: Fixture;

async function build(): Promise<Fixture> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-cleanup-')));
  const repo = join(root, 'Mon Projet');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, '.gitignore'), '.env*\n');
  await writeFile(join(repo, 'app.txt'), 'app\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  const path = (name: string) => join(root, name);
  for (const [name, branch] of [
    ['dev', 'feat/dev'],
    ['tester', 'feat/tester'],
    ['orch', 'feat/orch'],
    ['other', 'feat/other'],
  ] as const) {
    git(repo, 'worktree', 'add', '-b', branch, path(name));
  }
  const agent = (id: string, name: string, role: string, branch: string) => ({
    id,
    role,
    state: 'closed',
    worktreePath: path(name),
    branch,
    baseBranch: 'main',
  });
  const agents = {
    [DEV]: agent(DEV, 'dev', 'dev', 'feat/dev'),
    [TESTER]: agent(TESTER, 'tester', 'test', 'feat/tester'),
    [ORCH]: agent(ORCH, 'orch', 'orchestrator', 'feat/orch'),
    [OTHER]: agent(OTHER, 'other', 'dev', 'feat/other'),
  };
  const delivery = {
    id: DELIVERY,
    agentId: DEV,
    testAgentId: TESTER,
    state: 'merged',
    cleanup: 'kept',
    reason: 'dev : x',
    kept: [{ agentId: DEV, reason: 'x' }],
  } as Fixture['delivery'];
  const workspace = {
    id: 'w1',
    path: repo,
    mainBranch: 'main',
    testPaths: [...DEFAULT_TEST_PATHS],
    agents: Object.values(agents),
    deliveries: [delivery],
  };
  const merged = { head: git(path('dev'), 'rev-parse', 'HEAD') as string | null, fail: false };
  const save = vi.fn((_ws: string, _id: string, change: Record<string, unknown>) => {
    Object.assign(delivery, change);
    return Promise.resolve();
  });
  const cleanup = new WorktreeCleanup({
    workspaces: {
      get: (id) => (id === 'w1' ? (workspace as never) : undefined),
      list: () => [workspace as never],
    },
    git: new GitService({ env }),
    mergedHead: () =>
      merged.fail ? Promise.reject(new Error('forge down')) : Promise.resolve(merged.head),
    save,
  });
  return { root, repo, cleanup, save, delivery, agents, merged, workspace, path };
}

beforeEach(async () => {
  fx = await build();
});
afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true });
});

const setAgent = (id: string, patch: Record<string, unknown>) => {
  Object.assign(fx.agents[id] ?? {}, patch);
};
const branches = () => git(fx.repo, 'branch', '--format=%(refname:short)').split('\n').sort();
// Git prints `C:/…` on Windows: compare native, resolved paths, not the raw text.
const registered = () =>
  git(fx.repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));

describe('lost() reads the disk', () => {
  it('Given a clean worktree on the merged head, When asked, Then nothing would be lost', async () => {
    expect(await fx.cleanup.lost(DELIVERY, DEV)).toEqual([]);
  });

  it('Given untracked, modified and ignored .env files, When asked, Then each is listed with what it is', async () => {
    await writeFile(join(fx.path('dev'), 'notes.txt'), 'n');
    await writeFile(join(fx.path('dev'), 'app.txt'), 'changed\n');
    await writeFile(join(fx.path('dev'), '.env.local'), 'SECRET=1');

    const lost = await fx.cleanup.lost(DELIVERY, DEV);

    expect(lost).toEqual(
      expect.arrayContaining(['app.txt (modifié)', 'notes.txt (non suivi)', '.env.local (ignoré)']),
    );
    expect(lost).toHaveLength(3);
  });

  it('Given commits the PR does not hold, When asked, Then they are counted with their subjects', async () => {
    await writeFile(join(fx.path('dev'), 'more.txt'), 'm');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'encore un');
    await writeFile(join(fx.path('dev'), 'more2.txt'), 'm');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'encore deux');
    // The PR was merged at the first commit.
    fx.merged.head = git(fx.path('dev'), 'rev-parse', 'HEAD~2');

    const lost = await fx.cleanup.lost(DELIVERY, DEV);

    expect(lost).toEqual(['2 commits absents de la PR : encore deux, encore un']);
  });

  it('Given one commit, When asked, Then the line is singular', async () => {
    await writeFile(join(fx.path('dev'), 'more.txt'), 'm');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'seul');
    fx.merged.head = git(fx.path('dev'), 'rev-parse', 'HEAD~1');

    expect(await fx.cleanup.lost(DELIVERY, DEV)).toEqual(['1 commit absent de la PR : seul']);
  });

  it('Given a head of the PR this repository does not know, When asked, Then the commits are said to be unverifiable', async () => {
    fx.merged.head = 'f'.repeat(40);

    const lost = await fx.cleanup.lost(DELIVERY, DEV);

    expect(lost).toEqual(['commits non vérifiables']);
  });

  it('Given a head that cannot be read, When asked, Then the one line says so', async () => {
    fx.merged.head = null;

    expect(await fx.cleanup.lost(DELIVERY, DEV)).toEqual([
      'la tête de la PR est illisible : les commits ne peuvent pas être comptés',
    ]);
  });

  it('Given a worktree folder that is gone, When asked, Then the commits of its branch are read', async () => {
    await writeFile(join(fx.path('dev'), 'more.txt'), 'm');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'sur la branche');
    fx.merged.head = git(fx.path('dev'), 'rev-parse', 'HEAD~1');
    git(fx.repo, 'worktree', 'remove', '--force', fx.path('dev'));

    expect(await fx.cleanup.lost(DELIVERY, DEV)).toEqual([
      '1 commit absent de la PR : sur la branche',
    ]);
  });

  it('Given the tester, When a test it wrote is not in the PR, Then it is listed; when it is identical, Then it is not', async () => {
    fx.delivery.kept.push({ agentId: TESTER, reason: 'y' });
    await mkdir(join(fx.path('tester'), 'tests'));
    await writeFile(join(fx.path('tester'), 'tests', 'a.test.ts'), 'it();\n');
    git(fx.path('tester'), 'add', '.');
    git(fx.path('tester'), 'commit', '-m', 'test');

    expect(await fx.cleanup.lost(DELIVERY, TESTER)).toEqual([
      'tests/a.test.ts (test absent de la PR)',
    ]);

    // The PR holds the same file: nothing is lost.
    await mkdir(join(fx.path('dev'), 'tests'));
    await writeFile(join(fx.path('dev'), 'tests', 'a.test.ts'), 'it();\n');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'avec le test');
    fx.merged.head = git(fx.path('dev'), 'rev-parse', 'HEAD');

    expect(await fx.cleanup.lost(DELIVERY, TESTER)).toEqual([]);
  });

  it('Given an agent that is not kept, the orchestrator, an open agent or an unknown id, When asked, Then null or the refusal', async () => {
    expect(await fx.cleanup.lost(DELIVERY, TESTER)).toBeNull(); // not in `kept`
    fx.delivery.kept.push({ agentId: ORCH, reason: 'z' }, { agentId: OTHER, reason: 'z' });
    expect(await fx.cleanup.lost(DELIVERY, ORCH)).toBeNull(); // never the orchestrator
    expect(await fx.cleanup.lost(DELIVERY, OTHER)).toBeNull(); // not part of this delivery
    expect(await fx.cleanup.lost('d0000000-0000-4000-8000-0000000000ff', DEV)).toBeNull();
    setAgent(DEV, { state: 'working' });
    await expect(fx.cleanup.lost(DELIVERY, DEV)).rejects.toThrow(/rouvert/);
  });
});

describe('force() deletes exactly one dev worktree', () => {
  it('Given a dev worktree with unsaved work, When forced, Then its folder and its branch go, and nothing else', async () => {
    await writeFile(join(fx.path('dev'), 'notes.txt'), 'n');
    await writeFile(join(fx.path('dev'), 'app.txt'), 'changed\n');
    const mainBefore = git(fx.repo, 'rev-parse', 'main');

    await fx.cleanup.force(DELIVERY, DEV);

    expect(await present(fx.path('dev'))).toBe(false);
    expect(registered()).not.toContain(resolve(fx.path('dev')));
    expect(branches()).not.toContain('feat/dev');
    // The others are untouched: orchestrator, tester, another agent, main.
    for (const name of ['orch', 'tester', 'other']) {
      expect(await present(fx.path(name))).toBe(true);
      expect(registered()).toContain(resolve(fx.path(name)));
    }
    expect(branches()).toEqual(
      expect.arrayContaining(['main', 'feat/orch', 'feat/tester', 'feat/other']),
    );
    expect(git(fx.repo, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await present(join(fx.repo, 'app.txt'))).toBe(true);
  });

  it('Given the only kept worktree, When forced, Then the delivery is settled as done with no reason', async () => {
    await fx.cleanup.force(DELIVERY, DEV);

    expect(fx.delivery).toMatchObject({ cleanup: 'done', reason: null, kept: [] });
  });

  it('Given two kept worktrees, When the dev is forced, Then the tester stays kept and is the reason', async () => {
    fx.delivery.kept.push({ agentId: TESTER, reason: 'test absent' });

    await fx.cleanup.force(DELIVERY, DEV);

    expect(fx.delivery).toMatchObject({
      cleanup: 'kept',
      reason: 'testeur : test absent',
      kept: [{ agentId: TESTER, reason: 'test absent' }],
    });
    expect(await present(fx.path('tester'))).toBe(true);
  });

  it('Given the tester kept, When forced, Then its folder goes but its branch stays (the branch is the dev’s alone)', async () => {
    fx.delivery.kept = [{ agentId: TESTER, reason: 'y' }];

    await fx.cleanup.force(DELIVERY, TESTER);

    expect(await present(fx.path('tester'))).toBe(false);
    expect(branches()).toContain('feat/tester');
    expect(await present(fx.path('dev'))).toBe(true);
    expect(branches()).toContain('feat/dev');
  });

  it('Given a folder removed by hand and a branch already gone, When forced, Then the entry is cleared and the delivery is settled', async () => {
    await rm(fx.path('dev'), { recursive: true, force: true });
    git(fx.repo, 'worktree', 'prune');
    git(fx.repo, 'branch', '-D', 'feat/dev');

    await fx.cleanup.force(DELIVERY, DEV);

    expect(fx.delivery).toMatchObject({ cleanup: 'done', kept: [] });
  });

  it('Given a locked worktree, When forced, Then the failure is thrown, the branch stays and the delivery is not settled', async () => {
    git(fx.repo, 'worktree', 'lock', fx.path('dev'));

    await expect(fx.cleanup.force(DELIVERY, DEV)).rejects.toThrow(/lock/i);

    expect(await present(fx.path('dev'))).toBe(true);
    expect(branches()).toContain('feat/dev');
    expect(fx.save).not.toHaveBeenCalled();
    expect(fx.delivery).toMatchObject({ cleanup: 'kept', kept: [{ agentId: DEV, reason: 'x' }] });
  });

  it('Given a branch that is checked out elsewhere, When forced, Then the failure is thrown and nothing is settled', async () => {
    // The folder goes, then the branch cannot: it is the branch of another worktree too.
    git(fx.path('other'), 'checkout', '--detach');
    git(fx.repo, 'worktree', 'remove', '--force', fx.path('dev'));
    git(fx.repo, 'worktree', 'add', fx.path('twin'), 'feat/dev');
    setAgent(DEV, { worktreePath: fx.path('dev') });

    await expect(fx.cleanup.force(DELIVERY, DEV)).rejects.toThrow();

    expect(branches()).toContain('feat/dev');
    expect(fx.save).not.toHaveBeenCalled();
  });

  it('Given an agent that works again, When forced, Then nothing is removed', async () => {
    setAgent(DEV, { state: 'working' });

    await expect(fx.cleanup.force(DELIVERY, DEV)).rejects.toThrow(/rouvert/);

    expect(await present(fx.path('dev'))).toBe(true);
    expect(branches()).toContain('feat/dev');
  });

  it('Given the orchestrator, another agent or an unknown id, When forced, Then it is refused and nothing is removed', async () => {
    fx.delivery.kept.push({ agentId: ORCH, reason: 'z' });
    for (const id of [ORCH, OTHER, TESTER, 'a0000000-0000-4000-8000-0000000000ff']) {
      await expect(fx.cleanup.force(DELIVERY, id)).rejects.toThrow(/plus à supprimer/);
    }
    await expect(fx.cleanup.force('d0000000-0000-4000-8000-0000000000ff', DEV)).rejects.toThrow(
      /plus à supprimer/,
    );

    for (const name of ['dev', 'tester', 'orch', 'other'])
      expect(await present(fx.path(name))).toBe(true);
    expect(fx.save).not.toHaveBeenCalled();
  });
});

describe('keep() deletes nothing', () => {
  it('Given a kept worktree, When « Garder », Then the folder, the branch and the work stay and the item goes', async () => {
    await writeFile(join(fx.path('dev'), 'notes.txt'), 'n');

    await fx.cleanup.keep(DELIVERY, DEV);

    expect(await present(join(fx.path('dev'), 'notes.txt'))).toBe(true);
    expect(registered()).toContain(resolve(fx.path('dev')));
    expect(branches()).toContain('feat/dev');
    expect(fx.delivery).toMatchObject({ cleanup: 'done', reason: null, kept: [] });
  });

  it('Given two kept worktrees, When the dev is kept, Then the tester remains the open question', async () => {
    fx.delivery.kept.push({ agentId: TESTER, reason: 'test absent' });

    await fx.cleanup.keep(DELIVERY, DEV);

    expect(fx.delivery).toMatchObject({ cleanup: 'kept', reason: 'testeur : test absent' });
  });

  it('Given the dev and the tester kept, When the tester is settled, Then the dev is named in the reason', async () => {
    fx.delivery.kept.push({ agentId: TESTER, reason: 'test absent' });

    await fx.cleanup.keep(DELIVERY, TESTER);

    expect(fx.delivery).toMatchObject({ cleanup: 'kept', reason: 'dev : x' });
  });

  it('Given an unknown agent or delivery, When « Garder », Then nothing is written', async () => {
    await fx.cleanup.keep(DELIVERY, OTHER);
    await fx.cleanup.keep('d0000000-0000-4000-8000-0000000000ff', DEV);

    expect(fx.save).not.toHaveBeenCalled();
    for (const name of ['dev', 'tester', 'orch', 'other'])
      expect(await present(fx.path(name))).toBe(true);
  });
});

describe('run() — the cleanup of a merged request, against a real repository', () => {
  const pending = () => {
    fx.delivery.cleanup = 'pending';
    fx.delivery.reason = null;
    fx.delivery.kept = [];
  };
  const detachDev = () => git(fx.path('dev'), 'checkout', '--detach');

  beforeEach(pending);

  it('Given a clean dev and a clean tester on the merged head, When run, Then both folders and the dev branch go, nothing else', async () => {
    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('dev'))).toBe(false);
    expect(await present(fx.path('tester'))).toBe(false);
    expect(branches()).not.toContain('feat/dev');
    // The branch of the tester and everything of the orchestrator and of the others stay.
    expect(branches()).toEqual(
      expect.arrayContaining(['main', 'feat/tester', 'feat/orch', 'feat/other']),
    );
    for (const name of ['orch', 'other']) expect(await present(fx.path(name))).toBe(true);
    expect(fx.delivery).toMatchObject({ cleanup: 'done', reason: null, kept: [] });
  });

  it('Given a request whose cleanup is not pending, or an unknown one, When run, Then nothing is read nor written', async () => {
    fx.delivery.cleanup = 'none';
    await fx.cleanup.run('w1', DELIVERY);
    await fx.cleanup.run('nope', DELIVERY);
    await fx.cleanup.run('w1', 'd0000000-0000-4000-8000-0000000000ff');

    expect(fx.save).not.toHaveBeenCalled();
    expect(await present(fx.path('dev'))).toBe(true);
  });

  it('Given a second run while one is in progress, When both run, Then the cleanup is concluded once', async () => {
    await Promise.all([fx.cleanup.run('w1', DELIVERY), fx.cleanup.run('w1', DELIVERY)]);

    expect(fx.save).toHaveBeenCalledTimes(1);
  });

  it('Given work in the dev worktree, When run, Then it is kept with the reason and nothing is removed', async () => {
    await writeFile(join(fx.path('dev'), 'notes.txt'), 'n');
    await writeFile(join(fx.path('dev'), '.env'), 'S=1');

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(join(fx.path('dev'), 'notes.txt'))).toBe(true);
    expect(branches()).toContain('feat/dev');
    expect(fx.delivery.kept).toEqual([
      { agentId: DEV, reason: 'notes.txt non suivi, .env ignoré (.env)' },
    ]);
    expect(fx.delivery).toMatchObject({ cleanup: 'kept' });
    expect(String(fx.delivery.reason)).toContain('dev : notes.txt non suivi');
    // The tester was clean: its folder goes.
    expect(await present(fx.path('tester'))).toBe(false);
  });

  it('Given a head that cannot be read or a forge that fails, When run, Then closed agents are kept with that reason', async () => {
    for (const how of ['null', 'throws'] as const) {
      pending();
      if (how === 'null') fx.merged.head = null;
      else fx.merged.fail = true;

      await fx.cleanup.run('w1', DELIVERY);

      expect(fx.delivery.kept.map((k) => k.reason)).toEqual([
        'tête de la PR illisible',
        'tête de la PR illisible',
      ]);
      expect(await present(fx.path('dev'))).toBe(true);
      expect(await present(fx.path('tester'))).toBe(true);
    }
  });

  it('Given an agent that works again, When run, Then it is left alone and the request ends as « none »', async () => {
    setAgent(DEV, { state: 'working' });
    setAgent(TESTER, { state: 'working' });
    fx.merged.head = null;

    await fx.cleanup.run('w1', DELIVERY);
    expect(fx.delivery).toMatchObject({ cleanup: 'none', kept: [] });

    pending();
    fx.merged.head = git(fx.path('dev'), 'rev-parse', 'HEAD');
    await fx.cleanup.run('w1', DELIVERY);
    expect(fx.delivery).toMatchObject({ cleanup: 'none' });
    expect(await present(fx.path('dev'))).toBe(true);
  });

  it('Given the dev behind the merged head, When run, Then it is kept because its head is not the head of the PR', async () => {
    const base = git(fx.path('dev'), 'rev-parse', 'HEAD');
    git(fx.repo, 'branch', 'ahead', base);
    git(fx.repo, 'worktree', 'add', fx.path('ahead'), 'ahead');
    await writeFile(join(fx.path('ahead'), 'x.txt'), 'x');
    git(fx.path('ahead'), 'add', '.');
    git(fx.path('ahead'), 'commit', '-m', 'later');
    fx.merged.head = git(fx.path('ahead'), 'rev-parse', 'HEAD');

    await fx.cleanup.run('w1', DELIVERY);

    expect(fx.delivery.kept[0]).toEqual({
      agentId: DEV,
      reason: 'la tête du dev n’est pas la tête de la PR',
    });
    expect(await present(fx.path('dev'))).toBe(true);
  });

  it('Given a branch that moved on after the merge, When run, Then the folder goes but the branch stays, said', async () => {
    const head = git(fx.path('dev'), 'rev-parse', 'HEAD');
    await writeFile(join(fx.path('dev'), 'later.txt'), 'l');
    git(fx.path('dev'), 'add', '.');
    git(fx.path('dev'), 'commit', '-m', 'after the merge');
    git(fx.path('dev'), 'checkout', '--detach', head);
    fx.merged.head = head;

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('dev'))).toBe(false);
    expect(branches()).toContain('feat/dev');
    expect(fx.delivery.kept).toEqual([
      { agentId: DEV, reason: 'la branche du dev a avancé depuis la fusion' },
    ]);
  });

  it('Given a branch already gone, When run, Then the folder goes and nothing is kept', async () => {
    detachDev();
    git(fx.repo, 'branch', '-D', 'feat/dev');

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('dev'))).toBe(false);
    expect(fx.delivery).toMatchObject({ cleanup: 'done', kept: [] });
  });

  it('Given a branch that another worktree holds, When run, Then git’s refusal is the reason and the branch stays', async () => {
    detachDev();
    git(fx.repo, 'worktree', 'add', fx.path('twin'), 'feat/dev');

    await fx.cleanup.run('w1', DELIVERY);

    expect(branches()).toContain('feat/dev');
    expect(fx.delivery.kept).toHaveLength(1);
    expect(fx.delivery.kept[0]?.agentId).toBe(DEV);
    expect(fx.delivery.kept[0]?.reason).toMatch(/feat\/dev/);
    expect(await present(fx.path('twin'))).toBe(true);
  });

  it('Given a worktree git refuses to remove, When run, Then the error is the reason and everything stays', async () => {
    git(fx.repo, 'worktree', 'lock', fx.path('dev'));

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('dev'))).toBe(true);
    expect(branches()).toContain('feat/dev');
    expect(fx.delivery.kept[0]?.reason).toMatch(/lock/i);
  });

  it('Given a delivery whose agents are unknown, or the orchestrator, When run, Then nothing is touched and it ends done', async () => {
    fx.delivery.agentId = ORCH;
    fx.delivery.testAgentId = 'a0000000-0000-4000-8000-0000000000ff';

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('orch'))).toBe(true);
    expect(fx.delivery).toMatchObject({ cleanup: 'done', kept: [] });
  });

  it('Given a tester that cannot be compared with the PR, When run, Then it is kept with that reason', async () => {
    fx.workspace.mainBranch = 'no-such-main';
    setAgent(TESTER, { baseBranch: 'no-such-base' });

    await fx.cleanup.run('w1', DELIVERY);

    expect(fx.delivery.kept.find((k) => k.agentId === TESTER)?.reason).toBe(
      'les tests du testeur ne peuvent pas être comparés à la PR',
    );
    expect(await present(fx.path('tester'))).toBe(true);
  });

  it('Given a closed tile forgotten but noted at the merge, When run, Then the noted worktree is cleaned like the tile would be', async () => {
    const noted = { worktreePath: fx.path('dev'), branch: 'feat/dev' };
    const workspace = fx.workspace as unknown as { agents: unknown[] };
    workspace.agents = workspace.agents.filter((a) => (a as { id: string }).id !== DEV);
    fx.delivery.worktrees = [
      { agentId: DEV, role: 'dev', worktreePath: noted.worktreePath, branch: noted.branch },
    ];

    await fx.cleanup.run('w1', DELIVERY);

    expect(await present(fx.path('dev'))).toBe(false);
    expect(branches()).not.toContain('feat/dev');
  });
});
