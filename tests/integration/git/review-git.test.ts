import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';

// 002 T008 — the review snapshot (research R1) and its diff against main (R2), on real
// repositories in a folder with spaces and accents.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

const service = new GitService({ env: gitEnv });

let root: string;
let repo: string;
let worktree: string;

const write = async (path: string, content: string | Buffer) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-review-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await write(join(repo, 'a.txt'), 'un\ndeux\ntrois\n');
  await write(join(repo, 'b.txt'), 'b\n');
  await write(join(repo, 'old.txt'), 'à déplacer\nsur plusieurs\nlignes\n');
  await write(join(repo, 'gone.txt'), 'supprimé\n');
  await write(join(repo, 'crlf.txt'), 'x\ny\n');
  await write(join(repo, '.gitignore'), '*.log\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-b', 'agent/claude-code-1', worktree, 'main');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Committed, uncommitted, untracked, renamed, deleted and ignored changes in the worktree. */
const agentWorks = async () => {
  await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
  git(worktree, 'commit', '-am', 'Change a');
  await write(join(worktree, 'b.txt'), 'b\nb2\n');
  await write(join(worktree, 'src', 'Développement é', 'a b.ts'), 'export const a = 1;\n');
  await rename(join(worktree, 'old.txt'), join(worktree, 'moved.txt'));
  await rm(join(worktree, 'gone.txt'));
  await write(join(worktree, 'debug.log'), 'ignored\n');
};

const indexPath = () => join(worktree, git(worktree, 'rev-parse', '--git-path', 'index'));

describe('GitService.snapshot (R1)', () => {
  it('puts committed, uncommitted, untracked and renamed files in the tree, not ignored ones', async () => {
    await agentWorks();
    const { commit, tree } = await service.snapshot(worktree);
    expect(git(repo, 'rev-parse', `${commit}^{tree}`)).toBe(tree);
    const files = git(repo, 'ls-tree', '-r', '--name-only', '-z', tree).split('\0').filter(Boolean);
    expect(files.sort()).toEqual(
      [
        '.gitignore',
        'a.txt',
        'b.txt',
        'crlf.txt',
        'moved.txt',
        'src/Développement é/a b.ts',
      ].sort(),
    );
    expect(git(repo, 'show', `${tree}:b.txt`)).toBe('b\nb2');
  });

  it('leaves the status, the index and the branch of the worktree untouched', async () => {
    await agentWorks();
    const status = git(worktree, 'status', '--porcelain', '--untracked-files=all');
    const index = await readFile(indexPath());
    const head = git(worktree, 'rev-parse', 'HEAD');
    await service.snapshot(worktree);
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe(status);
    expect(await readFile(indexPath())).toEqual(index);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'branch', '--list')).not.toContain('pact');
  });

  it('gives the same tree id for the same content', async () => {
    await agentWorks();
    const first = await service.snapshot(worktree);
    const second = await service.snapshot(worktree);
    expect(second.tree).toBe(first.tree);
    await write(join(worktree, 'b.txt'), 'autre\n');
    expect((await service.snapshot(worktree)).tree).not.toBe(first.tree);
  });
});

describe('GitService.mergeBase', () => {
  it('is the commit the agent started from, even after main moved on', async () => {
    const start = git(repo, 'rev-parse', 'main');
    await write(join(repo, 'main.txt'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'main moves');
    await agentWorks();
    expect(await service.mergeBase(worktree, 'main', 'HEAD')).toBe(start);
  });
});

describe('GitService.changedFiles (R2)', () => {
  it('lists status, line counts and blob per file, sorted by path', async () => {
    await agentWorks();
    const base = await service.mergeBase(worktree, 'main', 'HEAD');
    const { tree } = await service.snapshot(worktree);
    const files = await service.changedFiles(worktree, base, tree);
    expect(files.map((f) => f.path)).toEqual([
      'a.txt',
      'b.txt',
      'gone.txt',
      'moved.txt',
      'src/Développement é/a b.ts',
    ]);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['a.txt']).toEqual({
      path: 'a.txt',
      oldPath: null,
      status: 'modified',
      added: 1,
      removed: 1,
      binary: false,
      tooLarge: false,
      eolOnly: false,
      blob: git(repo, 'rev-parse', `${tree}:a.txt`),
    });
    expect(byPath['gone.txt']).toMatchObject({
      status: 'deleted',
      added: 0,
      removed: 1,
      blob: null,
    });
    expect(byPath['moved.txt']).toMatchObject({ status: 'renamed', oldPath: 'old.txt' });
    expect(byPath['src/Développement é/a b.ts']).toMatchObject({ status: 'added', added: 1 });
  });

  it('flags binary files, without line counts', async () => {
    await write(join(worktree, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
    const { tree } = await service.snapshot(worktree);
    const [file] = await service.changedFiles(worktree, git(repo, 'rev-parse', 'main'), tree);
    expect(file).toMatchObject({ path: 'image.png', binary: true, added: null, removed: null });
  });

  it('flags files over 5 000 lines of diff as too large', async () => {
    await write(join(worktree, 'big.txt'), 'ligne\n'.repeat(5001));
    const { tree } = await service.snapshot(worktree);
    const [file] = await service.changedFiles(worktree, git(repo, 'rev-parse', 'main'), tree);
    expect(file).toMatchObject({ path: 'big.txt', tooLarge: true, added: 5001 });
  });

  it('keeps a file that only differs by line endings, flagged eolOnly', async () => {
    await write(join(worktree, 'crlf.txt'), 'x\r\ny\r\n');
    const { tree } = await service.snapshot(worktree);
    const files = await service.changedFiles(worktree, git(repo, 'rev-parse', 'main'), tree);
    expect(files).toEqual([expect.objectContaining({ path: 'crlf.txt', eolOnly: true })]);
  });
});

describe('GitService.fileDiff (R2)', () => {
  it('parses the diff of one file, accented path included', async () => {
    await agentWorks();
    const base = git(repo, 'rev-parse', 'main');
    const { tree } = await service.snapshot(worktree);
    const diff = await service.fileDiff(worktree, { base, tree, path: 'a.txt', oldPath: null });
    expect(diff.path).toBe('a.txt');
    expect(diff.hunks[0]?.lines.filter((l) => l.kind !== 'context')).toEqual([
      { kind: 'del', oldNo: 2, newNo: null, text: 'deux' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'DEUX' },
    ]);
    const added = await service.fileDiff(worktree, {
      base,
      tree,
      path: 'src/Développement é/a b.ts',
      oldPath: null,
    });
    expect(added.hunks[0]?.lines).toEqual([
      { kind: 'add', oldNo: null, newNo: 1, text: 'export const a = 1;' },
    ]);
    expect(added.size).toBe('export const a = 1;\n'.length);
  });

  it('follows a renamed file from its old path', async () => {
    await agentWorks();
    await write(join(worktree, 'moved.txt'), 'à déplacer\nsur plusieurs\nlignes\net une de plus\n');
    const base = git(repo, 'rev-parse', 'main');
    const { tree } = await service.snapshot(worktree);
    const diff = await service.fileDiff(worktree, {
      base,
      tree,
      path: 'moved.txt',
      oldPath: 'old.txt',
    });
    expect(diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context')).toEqual([
      { kind: 'add', oldNo: null, newNo: 4, text: 'et une de plus' },
    ]);
  });

  it('ignores carriage returns at the end of lines', async () => {
    await write(join(worktree, 'crlf.txt'), 'x\r\nY\r\n');
    const base = git(repo, 'rev-parse', 'main');
    const { tree } = await service.snapshot(worktree);
    const diff = await service.fileDiff(worktree, { base, tree, path: 'crlf.txt', oldPath: null });
    expect(diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context')).toEqual([
      { kind: 'del', oldNo: 2, newNo: null, text: 'y' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'Y' },
    ]);
  });

  it('gives no hunk for a binary or too large file, only its size', async () => {
    const big = 'ligne\n'.repeat(5001);
    await write(join(worktree, 'big.txt'), big);
    await write(join(worktree, 'image.png'), Buffer.from([0x89, 0x50, 0, 0]));
    const base = git(repo, 'rev-parse', 'main');
    const { tree } = await service.snapshot(worktree);
    expect(
      await service.fileDiff(worktree, { base, tree, path: 'big.txt', oldPath: null }),
    ).toEqual({ path: 'big.txt', hunks: [], size: big.length });
    expect(
      await service.fileDiff(worktree, { base, tree, path: 'image.png', oldPath: null }),
    ).toEqual({ path: 'image.png', hunks: [], size: 4 });
  });
});
