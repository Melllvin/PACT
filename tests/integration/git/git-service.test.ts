import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, type CloneProgress } from '../../../src/main/git/git-service';

// Real repositories in a folder with spaces and accents (spec edge case « Développement »).
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
const service = new GitService({ env: gitEnv });

const makeRepo = async (path: string, ...initArgs: string[]) => {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-b', 'main', ...initArgs);
  await writeFile(join(path, 'README.md'), '# test\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'initial');
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-git-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await makeRepo(repo);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('git environment (002 R2)', () => {
  it('reads git in English whatever the user locale, so errors can be parsed', async () => {
    const french = new GitService({
      env: { ...gitEnv, LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' },
    });
    await expect(
      french.removeWorktree(repo, { path: join(root, 'absent'), branch: 'absent' }),
    ).rejects.toThrow(/is not a working tree/);
  });
});

describe('repository queries', () => {
  it('recognizes a repository and rejects a plain or missing folder', async () => {
    expect(await service.isRepo(repo)).toBe(true);
    const plain = join(root, 'plain');
    await mkdir(plain);
    expect(await service.isRepo(plain)).toBe(false);
    expect(await service.isRepo(join(root, 'missing'))).toBe(false);
  });

  it('finds the repository root from a subfolder', async () => {
    const sub = join(repo, 'src', 'deep');
    await mkdir(sub, { recursive: true });
    expect(await service.repoRoot(sub)).toBe(repo);
  });

  it('reads the current branch', async () => {
    expect(await service.currentBranch(repo)).toBe('main');
  });

  it('initializes a new repository, creating the folder', async () => {
    const fresh = join(root, 'nouveau dépôt');
    await service.initRepo(fresh);
    expect(await service.isRepo(fresh)).toBe(true);
  });

  it('reports uncommitted changes so the user can be warned', async () => {
    expect(await service.hasUncommittedChanges(repo)).toBe(false);
    await writeFile(join(repo, 'README.md'), 'changed\n');
    expect(await service.hasUncommittedChanges(repo)).toBe(true);
  });
});

describe('worktrees', () => {
  it('creates .worktrees/<cli>-<n> on branch agent/<cli>-<n> from the base branch', async () => {
    const created = await service.addWorktree(repo, {
      cli: 'claude-code',
      position: 1,
      base: 'main',
    });
    expect(created).toEqual({
      path: join(repo, '.worktrees', 'claude-code-1'),
      branch: 'agent/claude-code-1',
    });
    expect(await service.currentBranch(created.path)).toBe('agent/claude-code-1');
    expect(git(created.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('leaves the main repository clean and its branch untouched (FR-014, FR-039)', async () => {
    await service.addWorktree(repo, { cli: 'codex', position: 2, base: 'main' });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(await service.currentBranch(repo)).toBe('main');
  });

  it('excludes /.worktrees/ once in .git/info/exclude and never touches .gitignore', async () => {
    await service.addWorktree(repo, { cli: 'codex', position: 1, base: 'main' });
    await service.addWorktree(repo, { cli: 'codex', position: 2, base: 'main' });
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split(/\r?\n/).filter((line) => line === '/.worktrees/')).toHaveLength(1);
    await expect(stat(join(repo, '.gitignore'))).rejects.toThrow();
  });

  it('adds /.worktrees/ on its own line after an exclude file without a final newline', async () => {
    await writeFile(join(repo, '.git', 'info', 'exclude'), '*.tmp');
    await service.addWorktree(repo, { cli: 'codex', position: 1, base: 'main' });
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '*.tmp\n/.worktrees/\n',
    );
  });

  it('adds a suffix instead of overwriting an existing branch', async () => {
    git(repo, 'branch', 'agent/codex-1');
    const created = await service.addWorktree(repo, { cli: 'codex', position: 1, base: 'main' });
    expect(created.branch).toBe('agent/codex-1-2');
    expect(created.path).toBe(join(repo, '.worktrees', 'codex-1-2'));
    expect(git(repo, 'branch', '--list', 'agent/codex-1')).toContain('agent/codex-1');
  });

  it('creates the worktree on the branch chosen in the launch form', async () => {
    const created = await service.addWorktree(repo, {
      cli: 'codex',
      position: 3,
      base: 'main',
      branch: 'feature/login',
    });
    expect(created).toEqual({ path: join(repo, '.worktrees', 'codex-3'), branch: 'feature/login' });
    expect(await service.currentBranch(created.path)).toBe('feature/login');
  });

  it('puts a chosen branch in a free folder when the usual one is taken', async () => {
    await mkdir(join(repo, '.worktrees', 'codex-3'), { recursive: true });
    const created = await service.addWorktree(repo, {
      cli: 'codex',
      position: 3,
      base: 'main',
      branch: 'feature/login',
    });
    expect(created.path).toBe(join(repo, '.worktrees', 'codex-3-2'));
  });

  it('refuses a chosen branch that already exists instead of reusing it', async () => {
    git(repo, 'branch', 'feature/login');
    await expect(
      service.addWorktree(repo, {
        cli: 'codex',
        position: 1,
        base: 'main',
        branch: 'feature/login',
      }),
    ).rejects.toThrow();
  });

  it('tells whether a local branch exists', async () => {
    expect(await service.branchExists(repo, 'main')).toBe(true);
    expect(await service.branchExists(repo, 'agent/none')).toBe(false);
  });

  it('writes the exclusion to the common git dir when .git is a file', async () => {
    const separate = join(root, 'separate');
    const gitDir = join(root, 'gitdir');
    await makeRepo(separate, '--separate-git-dir', gitDir);
    expect((await stat(join(separate, '.git'))).isFile()).toBe(true);

    await service.addWorktree(separate, { cli: 'codex', position: 1, base: 'main' });
    expect(await readFile(join(gitDir, 'info', 'exclude'), 'utf8')).toContain('/.worktrees/');
    expect(git(separate, 'status', '--porcelain')).toBe('');
  });

  it('follows a branch renamed inside the worktree', async () => {
    const { path } = await service.addWorktree(repo, { cli: 'codex', position: 1, base: 'main' });
    git(path, 'branch', '-m', 'feature/login');
    expect(await service.currentBranch(path)).toBe('feature/login');
  });

  it('removes a worktree and deletes its branch', async () => {
    const { path, branch } = await service.addWorktree(repo, {
      cli: 'codex',
      position: 1,
      base: 'main',
    });
    await service.removeWorktree(repo, { path, branch });
    await expect(stat(path)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', branch)).toBe('');
  });

  it('refuses to remove a worktree with uncommitted work unless forced', async () => {
    const { path, branch } = await service.addWorktree(repo, {
      cli: 'codex',
      position: 1,
      base: 'main',
    });
    await writeFile(join(path, 'wip.txt'), 'work in progress\n');
    await expect(service.removeWorktree(repo, { path, branch })).rejects.toThrow();
    await service.removeWorktree(repo, { path, branch, force: true });
    await expect(stat(path)).rejects.toThrow();
  });

  it('still removes the folder and the branch, forced, when git cannot (a file held on Windows)', async () => {
    const { path, branch } = await service.addWorktree(repo, {
      cli: 'codex',
      position: 1,
      base: 'main',
    });
    // Without its `.git` file, `git worktree remove` refuses the folder.
    await rm(join(path, '.git'));
    await service.removeWorktree(repo, { path, branch, force: true });
    await expect(stat(path)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', branch)).toBe('');
    expect(git(repo, 'worktree', 'list')).not.toContain('codex');
  });
});

describe('clone', () => {
  it('clones a repository and reports progress up to 100 %', async () => {
    const bare = join(root, 'origin.git');
    git(root, 'clone', '--bare', repo, bare);
    const destination = join(root, 'clone é');
    const progress: CloneProgress[] = [];

    await service.clone(pathToFileURL(bare).href, destination, (p) => progress.push(p));

    expect(await service.isRepo(destination)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.percent).toBe(100);
    expect(progress.every((p) => p.percent >= 0 && p.percent <= 100 && p.phase !== '')).toBe(true);
  });

  it('rejects with git’s message when the clone fails', async () => {
    await expect(
      service.clone(
        pathToFileURL(join(root, 'nothing-here.git')).href,
        join(root, 'out'),
        () => undefined,
      ),
    ).rejects.toThrow(/nothing-here/); // git's own (possibly localized) message names the source
  });
});

describe('removeWorktreeDir (008 R17, R2)', () => {
  const addWorktree = (name: string) => {
    const path = join(root, name);
    git(repo, 'worktree', 'add', '-b', name, path);
    return path;
  };
  const registered = () => git(repo, 'worktree', 'list', '--porcelain');

  it('removes a clean worktree directory and its registration, keeping the branch', async () => {
    const path = addWorktree('dev-a');
    await service.removeWorktreeDir(repo, path);
    expect(registered()).not.toContain(path);
    await expect(stat(path)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'dev-a')).toContain('dev-a');
  });

  it('refuses a worktree with local changes unless forced, and never touches it then', async () => {
    const path = addWorktree('dev-b');
    await writeFile(join(path, 'new.txt'), 'x');
    await expect(service.removeWorktreeDir(repo, path)).rejects.toThrow();
    expect((await stat(join(path, 'new.txt'))).isFile()).toBe(true);
    await service.removeWorktreeDir(repo, path, true);
    await expect(stat(path)).rejects.toThrow();
    expect(registered()).not.toContain(path);
  });

  it('clears only the entry of a missing directory, not the other missing worktrees', async () => {
    const gone = addWorktree('dev-gone');
    const unmounted = addWorktree('dev-unmounted');
    await rm(gone, { recursive: true, force: true });
    await rm(unmounted, { recursive: true, force: true });
    await service.removeWorktreeDir(repo, gone);
    const list = registered();
    expect(list).not.toContain(gone);
    // The other one may be on a disk that is only unmounted: git must still know it.
    expect(list).toContain(unmounted);
  });

  it('does nothing when the missing directory was never a registered worktree', async () => {
    const other = addWorktree('dev-other');
    await service.removeWorktreeDir(repo, join(root, 'never-there'));
    expect(registered()).toContain(other);
  });

  it('does nothing when the repository has no linked worktree at all', async () => {
    await expect(service.removeWorktreeDir(repo, join(root, 'nowhere'))).resolves.toBeUndefined();
  });

  it('skips an administrative entry that has no readable gitdir and still clears the right one', async () => {
    const gone = addWorktree('dev-gone2');
    await mkdir(join(repo, '.git', 'worktrees', 'broken'));
    await rm(gone, { recursive: true, force: true });

    await service.removeWorktreeDir(repo, gone);

    expect(registered()).not.toContain(gone);
    expect((await stat(join(repo, '.git', 'worktrees', 'broken'))).isDirectory()).toBe(true);
  });

  it('does not clear a registered worktree whose directory only has a sibling of the same name', async () => {
    const a = addWorktree('dev-same');
    await service.removeWorktreeDir(repo, `${a}-2`);
    expect(registered()).toContain(a);
  });
});

describe('deleteBranch and commitsNotIn (008 R17)', () => {
  it('deletes the named branch only', async () => {
    git(repo, 'branch', 'dev-x');
    git(repo, 'branch', 'dev-y');
    await service.deleteBranch(repo, 'dev-x');
    const branches = git(repo, 'branch', '--list');
    expect(branches).not.toContain('dev-x');
    expect(branches).toContain('dev-y');
    expect(branches).toContain('main');
  });

  it('deletes an unmerged branch (the caller has checked) and fails on an unknown one', async () => {
    git(repo, 'switch', '-c', 'dev-z');
    await writeFile(join(repo, 'z.txt'), 'z');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'z work');
    git(repo, 'switch', 'main');
    await service.deleteBranch(repo, 'dev-z');
    expect(git(repo, 'branch', '--list', 'dev-z')).toBe('');
    await expect(service.deleteBranch(repo, 'dev-nope')).rejects.toThrow();
  });

  it('lists the subjects of the commits that the base does not hold, newest first', async () => {
    git(repo, 'switch', '-c', 'dev-c');
    for (const n of ['one', 'two']) {
      await writeFile(join(repo, `${n}.txt`), n);
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `commit ${n}`);
    }
    expect(await service.commitsNotIn(repo, 'dev-c', 'main')).toEqual(['commit two', 'commit one']);
    expect(await service.commitsNotIn(repo, 'main', 'dev-c')).toEqual([]);
  });

  it('counts a commit with an empty subject', async () => {
    git(repo, 'switch', '-c', 'dev-e');
    await writeFile(join(repo, 'e.txt'), 'e');
    git(repo, 'add', '.');
    git(repo, 'commit', '--allow-empty-message', '-m', '');
    expect(await service.commitsNotIn(repo, 'dev-e', 'main')).toHaveLength(1);
  });
});
