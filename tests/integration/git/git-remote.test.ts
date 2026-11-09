import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';

// 008 T006 — the git steps of a delivery against a remote (research R5, R7, R13, R17, R18;
// contracts/gh.md « git distant »). A temporary repository and a BARE REPOSITORY ON THE DISK stand
// for GitHub: no network, and no `refs/pull/*` is ever created, here or by the code under test.
//
// RED until T010 adds to `GitService` (assumed API, listed in the report):
//   fetchRefs(cwd, branches): Promise<boolean>            false, without throwing, when it fails
//   rebaseOnto(repo, { commit, onto, dir }): Promise<{ commit: string | null; conflicts: string[] }>
//   pushBranch(repo, { commit, branch, expected }): Promise<boolean>   false when the lease refuses
//   deleteRemoteBranch(repo, branch, expected): Promise<boolean>        false when the lease refuses
//   statusIgnored(cwd): Promise<{ modified, untracked, ignoredEnv, ignoredOther }: string[]>

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};
const service = new GitService({ env: gitEnv });

let root: string;
let repo: string;
let bare: string;
let dev: string;
/** Another clone: what a colleague, or the forge, does to the remote. */
let colleague: string;
let base: string;

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};
const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
const refs = (cwd: string, ...patterns: string[]) =>
  git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', ...patterns);
const worktrees = (cwd: string) =>
  git(cwd, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync.native(line.slice('worktree '.length)));
const remoteHead = (branch: string) =>
  tryGit(bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-git-remote-')));
  bare = join(root, 'remote.git');
  repo = join(root, 'repo');
  dev = join(root, 'dev');
  colleague = join(root, 'colleague');
  await mkdir(bare);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  await write(join(repo, 'README.md'), '# test\n');
  base = commitAll(repo, 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  // The branch of the dev, in its own worktree, with the commit F on top of main.
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/connexion', dev);
  await write(join(dev, 'src', 'connexion.ts'), 'export const connexion = 1;\n');
  commitAll(dev, 'feat: connexion');
  git(root, 'clone', '-q', bare, colleague);
  git(colleague, 'config', 'user.name', 'Colleague');
  git(colleague, 'config', 'user.email', 'colleague@pact.dev');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The colleague pushes a commit to `branch` of the remote. */
const colleaguePushes = async (branch: string, file: string, content: string) => {
  if (tryGit(colleague, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) === null) {
    git(colleague, 'checkout', '-q', '-B', branch, 'origin/main');
  } else {
    git(colleague, 'checkout', '-q', branch);
  }
  await write(join(colleague, file), content);
  commitAll(colleague, `colleague: ${file}`);
  git(colleague, 'push', '-q', '--force', 'origin', branch);
};

describe('fetchRefs (FR-033, research R13)', () => {
  it('Given a remote with other branches and a tag, When two branches are asked, Then only their remote-tracking refs are created', async () => {
    await colleaguePushes('other', 'other.txt', 'x\n');
    await colleaguePushes('feat/connexion', 'colleague.txt', 'y\n');
    git(colleague, 'tag', 'v1');
    git(colleague, 'push', '-q', 'origin', 'v1');
    await colleaguePushes('main', 'main.txt', 'z\n');

    const before = refs(repo);
    await expect(service.fetchRefs(repo, ['main', 'feat/connexion'])).resolves.toBe(true);

    const created = refs(repo)
      .split('\n')
      .filter((line) => !before.split('\n').includes(line))
      .map((line) => line.split(' ')[0])
      .sort();
    // `origin/main` existed (pushed in the setup): it moves; `origin/feat/connexion` is new.
    expect(created).toEqual(['refs/remotes/origin/feat/connexion', 'refs/remotes/origin/main']);
    expect(refs(repo, 'refs/remotes/origin/other')).toBe('');
    expect(refs(repo, 'refs/tags')).toBe('');
    expect(refs(repo, 'refs/pull', 'refs/remotes/origin/pull')).toBe('');
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(git(bare, 'rev-parse', 'main'));
  });

  it('Given a fetch, When it ends, Then no local branch, HEAD or worktree moved', async () => {
    await colleaguePushes('main', 'main.txt', 'z\n');
    const heads = refs(repo, 'refs/heads');
    const head = git(repo, 'rev-parse', 'HEAD');
    const devHead = git(dev, 'rev-parse', 'HEAD');
    await service.fetchRefs(repo, ['main']);
    expect(refs(repo, 'refs/heads')).toBe(heads);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dev, 'rev-parse', 'HEAD')).toBe(devHead);
    expect(git(dev, 'status', '--porcelain')).toBe('');
  });

  it('Given a remote that cannot be reached, When fetched, Then it answers false and throws nothing', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
    await expect(service.fetchRefs(repo, ['main'])).resolves.toBe(false);
  });
});

describe('rebaseOnto (research R5)', () => {
  const dir = () => join(root, 'delivery-1');
  const F = () => git(dev, 'rev-parse', 'HEAD');

  it('Given main moved on, When the commit is replayed, Then R is the same change on top of origin/main', async () => {
    await colleaguePushes('main', 'main.txt', 'from main\n');
    await service.fetchRefs(repo, ['main']);
    const f = F();

    const result = await service.rebaseOnto(repo, { commit: f, onto: 'origin/main', dir: dir() });

    expect(result.conflicts).toEqual([]);
    const r = result.commit ?? '';
    expect(r).toMatch(/^[0-9a-f]{40}$/);
    expect(r).not.toBe(f);
    expect(git(repo, 'rev-parse', `${r}^`)).toBe(git(repo, 'rev-parse', 'origin/main'));
    // The same content replayed: the change of R is the change of F, and main's file is there too.
    expect(git(repo, 'diff', '--name-only', `${r}^`, r)).toBe('src/connexion.ts');
    expect(git(repo, 'show', `${r}:src/connexion.ts`)).toBe(
      git(repo, 'show', `${f}:src/connexion.ts`),
    );
    expect(git(repo, 'show', `${r}:main.txt`)).toBe('from main');
    expect(git(repo, 'log', '-1', '--format=%s', r)).toBe('feat: connexion');
  });

  it('Given the worktree of the dev with work in progress, When the commit is replayed, Then the worktree, its branch and its files are not touched (Q24)', async () => {
    await colleaguePushes('main', 'main.txt', 'from main\n');
    await service.fetchRefs(repo, ['main']);
    await write(join(dev, 'src', 'connexion.ts'), 'export const connexion = 2; // en cours\n');
    await write(join(dev, 'notes.txt'), 'brouillon\n');
    const head = F();
    const status = git(dev, 'status', '--porcelain');

    await service.rebaseOnto(repo, { commit: head, onto: 'origin/main', dir: dir() });

    expect(git(dev, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'rev-parse', 'feat/connexion')).toBe(head);
    expect(git(dev, 'status', '--porcelain')).toBe(status);
    expect(git(dev, 'branch', '--show-current')).toBe('feat/connexion');
  });

  it('Given the hooks of the repository, When the commit is replayed, Then none runs and none can refuse (core.hooksPath empty)', async () => {
    const marker = join(root, 'hook-ran');
    for (const name of ['pre-rebase', 'post-checkout', 'post-rewrite', 'pre-commit']) {
      const path = join(repo, '.git', 'hooks', name);
      await write(path, `#!/bin/sh\necho ${name} >> "${marker}"\nexit 1\n`);
      await chmod(path, 0o755);
    }
    await colleaguePushes('main', 'main.txt', 'from main\n');
    await service.fetchRefs(repo, ['main']);

    const result = await service.rebaseOnto(repo, { commit: F(), onto: 'origin/main', dir: dir() });

    expect(result.commit).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('Given the temporary worktree, When the replay ends, Then it is gone and the repository lists only its own worktrees', async () => {
    await colleaguePushes('main', 'main.txt', 'from main\n');
    await service.fetchRefs(repo, ['main']);
    await service.rebaseOnto(repo, { commit: F(), onto: 'origin/main', dir: dir() });
    expect(existsSync(dir())).toBe(false);
    expect(worktrees(repo).sort()).toEqual([dev, repo].sort());
    expect(await readdir(join(repo, '.git', 'worktrees'))).toHaveLength(1);
  });

  it('Given origin/main already holding the commit, When asked, Then R is F: nothing is replayed', async () => {
    const f = F();
    git(repo, 'push', '-q', 'origin', `${f}:refs/heads/main`);
    await service.fetchRefs(repo, ['main']);
    const result = await service.rebaseOnto(repo, { commit: f, onto: 'origin/main', dir: dir() });
    expect(result).toEqual({ commit: f, conflicts: [] });
  });

  it('Given a conflict, When the commit is replayed, Then the files are returned and nothing is left behind', async () => {
    await colleaguePushes('main', 'src/connexion.ts', 'export const connexion = "autre";\n');
    await service.fetchRefs(repo, ['main']);
    const f = F();
    const before = refs(repo);

    const result = await service.rebaseOnto(repo, { commit: f, onto: 'origin/main', dir: dir() });

    expect(result.commit).toBeNull();
    expect(result.conflicts).toEqual(['src/connexion.ts']);
    expect(existsSync(dir())).toBe(false);
    expect(worktrees(repo).sort()).toEqual([dev, repo].sort());
    expect(await readdir(join(repo, '.git', 'worktrees'))).toHaveLength(1);
    expect(refs(repo)).toBe(before);
    expect(git(dev, 'rev-parse', 'HEAD')).toBe(f);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(repo, '.git', 'rebase-apply'))).toBe(false);
  });
});

describe('pushBranch (research R7)', () => {
  const f = () => git(dev, 'rev-parse', 'HEAD');

  it('Given a branch absent from the remote, When pushed with no expected head, Then the commit is there (and a commit no ref holds can be pushed)', async () => {
    await colleaguePushes('main', 'main.txt', 'x\n');
    await service.fetchRefs(repo, ['main']);
    const { commit } = await service.rebaseOnto(repo, {
      commit: f(),
      onto: 'origin/main',
      dir: join(root, 'delivery-1'),
    });
    expect(commit).not.toBeNull();
    await expect(
      service.pushBranch(repo, { commit: commit ?? '', branch: 'feat/connexion', expected: null }),
    ).resolves.toBe(true);
    expect(remoteHead('feat/connexion')).toBe(commit);
    expect(refs(bare, 'refs/pull')).toBe('');
  });

  it('Given a branch that exists on the remote, When pushed as if it did not, Then the lease refuses', async () => {
    await colleaguePushes('feat/connexion', 'colleague.txt', 'y\n');
    const theirs = remoteHead('feat/connexion');
    await expect(
      service.pushBranch(repo, { commit: f(), branch: 'feat/connexion', expected: null }),
    ).resolves.toBe(false);
    expect(remoteHead('feat/connexion')).toBe(theirs);
  });

  it('Given a remote head that changed since the last push, When pushed, Then the lease refuses and the remote keeps its commit (R7)', async () => {
    await service.pushBranch(repo, { commit: f(), branch: 'feat/connexion', expected: null });
    const pushed = f();
    await colleaguePushes('feat/connexion', 'colleague.txt', 'y\n');
    const theirs = remoteHead('feat/connexion');
    expect(theirs).not.toBe(pushed);

    await write(join(dev, 'more.txt'), 'm\n');
    const next = commitAll(dev, 'more');
    await expect(
      service.pushBranch(repo, { commit: next, branch: 'feat/connexion', expected: pushed }),
    ).resolves.toBe(false);
    expect(remoteHead('feat/connexion')).toBe(theirs);
  });

  it('Given the expected head, When a rewritten history is pushed, Then it replaces the old one', async () => {
    await service.pushBranch(repo, { commit: f(), branch: 'feat/connexion', expected: null });
    const pushed = f();
    // A history that does not contain `pushed`: a recalage.
    git(dev, 'reset', '-q', '--hard', base);
    await write(join(dev, 'src', 'connexion.ts'), 'export const connexion = "réécrit";\n');
    const rewritten = commitAll(dev, 'feat: connexion, réécrit');
    await expect(
      service.pushBranch(repo, { commit: rewritten, branch: 'feat/connexion', expected: pushed }),
    ).resolves.toBe(true);
    expect(remoteHead('feat/connexion')).toBe(rewritten);
  });

  it('Given a push, When it ends, Then no other branch of the remote moved', async () => {
    const main = remoteHead('main');
    await service.pushBranch(repo, { commit: f(), branch: 'feat/connexion', expected: null });
    expect(remoteHead('main')).toBe(main);
  });
});

describe('remoteBranchHead (the lease of a new request)', () => {
  it('Given a branch on the remote, When read, Then it gives its head', async () => {
    const f = git(dev, 'rev-parse', 'HEAD');
    await service.pushBranch(repo, { commit: f, branch: 'feat/connexion', expected: null });
    await expect(service.remoteBranchHead(repo, 'feat/connexion')).resolves.toBe(f);
  });

  it('Given a branch absent from the remote, When read, Then it gives null', async () => {
    await expect(service.remoteBranchHead(repo, 'feat/absente')).resolves.toBeNull();
  });

  it('Given a remote that cannot be reached, When read, Then it gives null and does not throw', async () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'nowhere.git'));
    await expect(service.remoteBranchHead(repo, 'feat/connexion')).resolves.toBeNull();
  });
});

describe('deleteRemoteBranch (research R18)', () => {
  it('Given the branch still at the merged commit, When deleted, Then it is gone from the remote and main stays', async () => {
    const f = git(dev, 'rev-parse', 'HEAD');
    await service.pushBranch(repo, { commit: f, branch: 'feat/connexion', expected: null });
    const main = remoteHead('main');
    await expect(service.deleteRemoteBranch(repo, 'feat/connexion', f)).resolves.toBe(true);
    expect(remoteHead('feat/connexion')).toBeNull();
    expect(remoteHead('main')).toBe(main);
  });

  it('Given a branch that moved since the merge, When deleted, Then the lease refuses and the branch stays (Q26)', async () => {
    const f = git(dev, 'rev-parse', 'HEAD');
    await service.pushBranch(repo, { commit: f, branch: 'feat/connexion', expected: null });
    await colleaguePushes('feat/connexion', 'colleague.txt', 'y\n');
    const theirs = remoteHead('feat/connexion');
    await expect(service.deleteRemoteBranch(repo, 'feat/connexion', f)).resolves.toBe(false);
    expect(remoteHead('feat/connexion')).toBe(theirs);
  });

  it('Given a branch already gone, When deleted, Then nothing is deleted and nothing throws', async () => {
    const f = git(dev, 'rev-parse', 'HEAD');
    await expect(service.deleteRemoteBranch(repo, 'feat/connexion', f)).resolves.toBe(false);
  });
});

describe('statusIgnored (FR-034, Q25, research R17)', () => {
  let tree: string;
  beforeEach(async () => {
    tree = join(root, 'tree');
    git(repo, 'worktree', 'add', '-q', '-b', 'status-branch', tree);
    await write(join(tree, '.gitignore'), 'node_modules/\ndist/\n.env*\n!.env.example\n');
    await write(join(tree, 'a.txt'), 'a\n');
    await write(join(tree, 'gone.txt'), 'g\n');
    await write(join(tree, '.env.example'), 'KEY=\n');
    commitAll(tree, 'files');
  });

  it('Given a clean worktree, When read, Then nothing is listed', async () => {
    await expect(service.statusIgnored(tree)).resolves.toEqual({
      modified: [],
      untracked: [],
      ignoredEnv: [],
      ignoredOther: [],
    });
  });

  it('Given every kind of file, When read, Then modified, untracked, ignored .env* and other ignored files are told apart', async () => {
    await write(join(tree, 'a.txt'), 'changed\n');
    await rm(join(tree, 'gone.txt'));
    await write(join(tree, 'staged.txt'), 's\n');
    git(tree, 'add', 'staged.txt');
    await write(join(tree, 'new.txt'), 'n\n');
    await write(join(tree, '.env'), 'SECRET=1\n');
    await write(join(tree, 'packages', 'api', '.env.production'), 'SECRET=2\n');
    await write(join(tree, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    await write(join(tree, 'dist', 'out.js'), 'x\n');

    const status = await service.statusIgnored(tree);

    expect([...status.modified].sort()).toEqual(['a.txt', 'gone.txt', 'staged.txt']);
    expect(status.untracked).toEqual(['new.txt']);
    expect([...status.ignoredEnv].sort()).toEqual(['.env', 'packages/api/.env.production']);
    // `node_modules` and `dist` are ignored: they never make a worktree dirty (SC-010's other half).
    expect(status.ignoredOther.some((path) => path.startsWith('node_modules'))).toBe(true);
    expect(status.ignoredOther.some((path) => path.startsWith('dist'))).toBe(true);
    expect(status.ignoredOther.some((path) => path.includes('.env'))).toBe(false);
    expect(status.modified.concat(status.untracked)).not.toContain('.env.example');
  });

  it('Given a renamed file, When read, Then the new path is modified and the old one is not listed apart', async () => {
    git(tree, 'mv', 'a.txt', 'b.txt');
    const status = await service.statusIgnored(tree);
    expect(status.modified).toEqual(['b.txt']);
    expect(status.untracked).toEqual([]);
  });

  it('Given only node_modules ignored, When read, Then the worktree counts as clean for the other fields', async () => {
    await write(join(tree, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    const status = await service.statusIgnored(tree);
    expect([status.modified, status.untracked, status.ignoredEnv]).toEqual([[], [], []]);
    expect(status.ignoredOther.length).toBeGreaterThan(0);
  });
});

describe('hasWorkflows (research R10)', () => {
  it('Given a ref with a workflow file, When asked, Then true', async () => {
    await write(join(dev, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    commitAll(dev, 'ci: workflow');
    expect(await service.hasWorkflows(dev, 'HEAD')).toBe(true);
  });

  it('Given a ref with no workflow, When asked, Then false', async () => {
    expect(await service.hasWorkflows(dev, 'HEAD')).toBe(false);
  });

  it('Given a ref that does not exist, When asked, Then false and no throw', async () => {
    expect(await service.hasWorkflows(dev, 'refs/heads/nope')).toBe(false);
  });
});

describe('rebaseOnto: a failure that is not a conflict (research R5)', () => {
  it('Given a replay that fails with no conflicting file, When asked, Then it throws and leaves nothing behind', async () => {
    await colleaguePushes('main', 'main.txt', 'from main\n');
    await service.fetchRefs(repo, ['main']);
    // No identity anywhere: the replay cannot commit, and no file is in conflict.
    const lonely = new GitService({
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.useConfigOnly',
        GIT_CONFIG_VALUE_0: 'true',
      },
    });
    const dir = join(root, 'delivery-bad');
    await expect(
      lonely.rebaseOnto(repo, { commit: git(dev, 'rev-parse', 'HEAD'), onto: 'origin/main', dir }),
    ).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
