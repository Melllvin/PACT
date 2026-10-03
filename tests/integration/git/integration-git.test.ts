import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService, LocalChangesError, gitErrorOutput } from '../../../src/main/git/git-service';

// 002 T031 — the git steps of an integration (research R5): a commit made with the repository's
// hooks in a temporary worktree, then main moved once.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
/** Not trimmed: the first column tells staged from unstaged. */
const status = (cwd: string) =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });

const service = new GitService({ env: gitEnv });

let root: string;
let repo: string;
let worktree: string;
let temp: string;

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};

const hook = async (name: string, script: string) => {
  const path = join(repo, '.git', 'hooks', name);
  await write(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
};

const gone = async (path: string) => {
  try {
    await stat(path);
    return false;
  } catch {
    return true;
  }
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-integration-git-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await write(join(repo, 'a.txt'), 'un\ndeux\n');
  await write(join(repo, 'b.txt'), 'b\n');
  commitAll(repo, 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/claude-code-1', worktree, 'main');
  temp = join(root, 'userData', 'integrations', 'Intégration 1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GitService.commitWithHooks (R5)', () => {
  it('commits a tree on top of main with the message given, main left where it was', async () => {
    const main = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    await write(join(worktree, 'nouveau é.txt'), 'nouveau\n');
    await rm(join(worktree, 'b.txt'));
    const { tree } = await service.snapshot(worktree);
    const commit = await service.commitWithHooks(repo, {
      dir: temp,
      onto: main,
      tree,
      message: 'Ajoute le total\n\nDétails',
    });
    expect(git(repo, 'rev-parse', `${commit}^{tree}`)).toBe(tree);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', commit)).toBe(`${commit} ${main}`);
    expect(git(repo, 'log', '-1', '--format=%B', commit)).toBe('Ajoute le total\n\nDétails');
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    expect(await gone(temp)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('Intégration 1');
  });

  it('makes a merge commit of main and the commit given', async () => {
    const main = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    commitAll(worktree, 'Agent change');
    const agent = git(worktree, 'rev-parse', 'HEAD');
    const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
    const commit = await service.commitWithHooks(repo, {
      dir: temp,
      onto: main,
      tree,
      merge: agent,
      message: 'Merge agent',
    });
    expect(git(repo, 'rev-list', '--parents', '-n', '1', commit)).toBe(
      `${commit} ${main} ${agent}`,
    );
    expect(git(repo, 'rev-parse', `${commit}^{tree}`)).toBe(tree);
  });

  it('fails with the output of a pre-commit hook that refuses, and cleans up', async () => {
    await hook('pre-commit', 'echo "lint: 2 erreurs"\nexit 1');
    const main = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    const { tree } = await service.snapshot(worktree);
    const failure = await service
      .commitWithHooks(repo, { dir: temp, onto: main, tree, message: 'Refusé' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(gitErrorOutput(failure)).toContain('lint: 2 erreurs');
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    expect(await gone(temp)).toBe(true);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('Intégration 1');
  });

  it('keeps the message a commit-msg hook rewrote', async () => {
    await hook(
      'commit-msg',
      'printf "[PROJ-1] %s\\n" "$(cat "$1")" > "$1.new" && mv "$1.new" "$1"',
    );
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    const { tree } = await service.snapshot(worktree);
    const commit = await service.commitWithHooks(repo, {
      dir: temp,
      onto: git(repo, 'rev-parse', 'main'),
      tree,
      message: 'Ajoute le total',
    });
    expect(git(repo, 'log', '-1', '--format=%s', commit)).toBe('[PROJ-1] Ajoute le total');
  });
});

describe('GitService.fastForward (R5, FR-021)', () => {
  const agentCommit = async () => {
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    commitAll(worktree, 'Agent change');
    return git(worktree, 'rev-parse', 'HEAD');
  };

  it('moves the branch checked out and its files', async () => {
    const commit = await agentCommit();
    await service.fastForward(repo, commit);
    expect(git(repo, 'rev-parse', 'main')).toBe(commit);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('un\nDEUX\n');
  });

  it('refuses over local changes to a file it touches, listing them, and changes nothing', async () => {
    const commit = await agentCommit();
    const main = git(repo, 'rev-parse', 'main');
    await write(join(repo, 'a.txt'), 'modifié à la main\n');
    const failure = await service.fastForward(repo, commit).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LocalChangesError);
    expect((failure as LocalChangesError).files).toEqual(['a.txt']);
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('modifié à la main\n');
  });

  it('keeps local changes to other files', async () => {
    const commit = await agentCommit();
    await write(join(repo, 'b.txt'), 'b local\n');
    await service.fastForward(repo, commit);
    expect(git(repo, 'rev-parse', 'main')).toBe(commit);
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('b local\n');
  });

  it('passes on any other git failure', async () => {
    await expect(service.fastForward(repo, 'nope')).rejects.not.toBeInstanceOf(LocalChangesError);
  });
});

describe('GitService.updateRef (R5, FR-022)', () => {
  it('moves a branch from the commit expected only', async () => {
    const main = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    commitAll(worktree, 'Agent change');
    const commit = git(worktree, 'rev-parse', 'HEAD');
    await expect(service.updateRef(repo, 'main', commit, commit)).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    await service.updateRef(repo, 'main', commit, main);
    expect(git(repo, 'rev-parse', 'main')).toBe(commit);
  });
});

describe('GitService.worktreeOf', () => {
  it('finds the folder where a branch is checked out, as a native path', async () => {
    expect(await service.worktreeOf(repo, 'main')).toBe(repo);
    expect(await service.worktreeOf(repo, 'agent/claude-code-1')).toBe(worktree);
    git(repo, 'branch', 'libre');
    expect(await service.worktreeOf(repo, 'libre')).toBeNull();
  });
});

describe('GitService.moveWorktree (R5, US2/AC4)', () => {
  it('puts the worktree on a commit, its own changes dropped', async () => {
    const target = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\n');
    commitAll(worktree, 'Agent change');
    await write(join(worktree, 'b.txt'), 'non commité\n');
    await service.moveWorktree(worktree, target, target);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(target);
    expect(status(worktree)).toBe('');
  });

  it('carries a tree over as changes left to commit, untracked files included', async () => {
    const target = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'b.txt'), 'b plus tard\n');
    await write(join(worktree, 'nouveau.txt'), 'nouveau\n');
    const { tree } = await service.snapshot(worktree);
    await write(join(worktree, 'a.txt'), 'remplacé par l’arbre\n');
    await service.moveWorktree(worktree, target, tree);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(target);
    expect(await readFile(join(worktree, 'b.txt'), 'utf8')).toBe('b plus tard\n');
    expect(await readFile(join(worktree, 'a.txt'), 'utf8')).toBe('un\ndeux\n');
    expect(status(worktree)).toBe(' M b.txt\n?? nouveau.txt\n');
  });
});

describe('gitErrorOutput (FR-023)', () => {
  it('gives what git wrote on its error output, else on its output, else the message', () => {
    expect(gitErrorOutput({ stderr: ' refusé \n', stdout: 'x', message: 'm' })).toBe('refusé');
    expect(gitErrorOutput({ stderr: '', stdout: 'rien à valider\n', message: 'm' })).toBe(
      'rien à valider',
    );
    expect(gitErrorOutput(new Error('perdu'))).toBe('perdu');
  });
});
