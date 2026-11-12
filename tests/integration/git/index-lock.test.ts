import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';

// 009 T034 — `indexLock`: the path of the Git lock of a worktree when there is one. Only read: PACT
// never erases a lock, which may belong to a Git command still running.
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
let worktree: string;
const service = new GitService({ env: gitEnv });

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-lock-')));
  repo = join(root, 'Dépôt');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), '# test\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  worktree = join(root, 'worktree');
  git(repo, 'worktree', 'add', '-b', 'agent/x', worktree);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GitService.indexLock', () => {
  it('Given no lock, When asked, Then it answers null', async () => {
    expect(await service.indexLock(repo)).toBeNull();
    expect(await service.indexLock(worktree)).toBeNull();
  });

  it('Given a lock in the repository (a path relative to it), When asked, Then it names the file and leaves it', async () => {
    const lock = join(repo, '.git', 'index.lock');
    await writeFile(lock, '');
    expect(await service.indexLock(repo)).toBe(lock);
    expect(existsSync(lock)).toBe(true);
  });

  it('Given a lock in a linked worktree (an absolute path), When asked, Then it names that file and leaves it', async () => {
    const lock = join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    await writeFile(lock, '');
    expect(await service.indexLock(worktree)).toBe(lock);
    expect(existsSync(lock)).toBe(true);
  });
});
