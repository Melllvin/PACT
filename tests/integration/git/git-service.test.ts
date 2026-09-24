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
