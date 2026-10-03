import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';

// 002 T026 — the conflict check against main (research R4): objects only, nothing else touched.

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

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-merge-tree-')));
  repo = join(root, 'Mes Projets', 'Développement');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await write(join(repo, 'a.txt'), 'un\ndeux\ntrois\n');
  await write(join(repo, 'b.txt'), 'b\n');
  await write(join(repo, 'Dossier é', 'c d.txt'), 'c\n');
  commitAll(repo, 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/claude-code-1', worktree, 'main');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under `dir`, `.git` included, byte for byte, with the refs and the status. */
const fingerprint = async (dir: string) => {
  const files: Record<string, string> = {};
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (full !== join(repo, '.worktrees')) await walk(full);
      } else {
        files[full] = (await readFile(full)).toString('base64');
      }
    }
  };
  await walk(dir);
  return {
    files,
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
  };
};

describe('GitService.mergeTree (R4)', () => {
  it('merges cleanly the changes of main and of the agent into one tree', async () => {
    await write(join(repo, 'b.txt'), 'b de main\n');
    commitAll(repo, 'Main change b');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const { commit } = await service.snapshot(worktree);
    const { tree, conflicts } = await service.mergeTree(repo, 'main', commit);
    expect(conflicts).toEqual([]);
    expect(git(repo, 'show', `${tree}:a.txt`)).toBe('un\nDEUX\ntrois');
    expect(git(repo, 'show', `${tree}:b.txt`)).toBe('b de main');
  });

  it('lists the conflicting paths with their kind, accented paths included', async () => {
    await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
    await rm(join(repo, 'b.txt'));
    await write(join(repo, 'Dossier é', 'c d.txt'), 'c de main\n');
    await write(join(repo, 'nouveau.txt'), 'main\n');
    commitAll(repo, 'Ajout SSO');
    await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
    await write(join(worktree, 'b.txt'), 'b de l’agent\n');
    await write(join(worktree, 'Dossier é', 'c d.txt'), 'c de l’agent\n');
    await write(join(worktree, 'nouveau.txt'), 'agent\n');
    await write(join(worktree, 'sans conflit.txt'), 'ok\n');
    const { commit } = await service.snapshot(worktree);
    const { tree, conflicts } = await service.mergeTree(repo, 'main', commit);
    expect(conflicts).toEqual([
      { path: 'Dossier é/c d.txt', kind: 'content' },
      { path: 'a.txt', kind: 'content' },
      { path: 'b.txt', kind: 'delete-modify' },
      { path: 'nouveau.txt', kind: 'add-add' },
    ]);
    // The merged tree holds the conflict markers, and the clean files.
    expect(git(repo, 'show', `${tree}:a.txt`)).toContain('<<<<<<<');
    expect(git(repo, 'show', `${tree}:sans conflit.txt`)).toBe('ok');
  });

  it('changes neither main, its folder, nor the worktree of the agent', async () => {
    await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
    commitAll(repo, 'Main change a');
    await write(join(repo, 'b.txt'), 'local, non commité\n');
    await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
    await write(join(worktree, 'brouillon.txt'), 'non suivi\n');
    const { commit } = await service.snapshot(worktree);
    const before = { main: await fingerprint(repo), agent: await fingerprint(worktree) };
    await service.mergeTree(repo, 'main', commit);
    expect({ main: await fingerprint(repo), agent: await fingerprint(worktree) }).toEqual(before);
  });

  it('merges against the base given instead of the merge base of the two', async () => {
    const start = git(repo, 'rev-parse', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDEUX\ntrois\n');
    const first = await service.snapshot(worktree);
    await write(join(worktree, 'b.txt'), 'b plus tard\n');
    const later = await service.snapshot(worktree);
    // From the first snapshot, only the later edit of b.txt is carried onto main.
    const { tree, conflicts } = await service.mergeTree(repo, start, later.commit, first.commit);
    expect(conflicts).toEqual([]);
    expect(git(repo, 'show', `${tree}:a.txt`)).toBe('un\ndeux\ntrois');
    expect(git(repo, 'show', `${tree}:b.txt`)).toBe('b plus tard');
  });

  it('reports a git failure as an error, not as a conflict', async () => {
    await expect(service.mergeTree(repo, 'main', 'nope')).rejects.toThrow();
  });
});

describe('GitService.lastMainCommit (R4)', () => {
  it('names the commit of main that last touched a file since the base', async () => {
    const base = git(repo, 'rev-parse', 'main');
    await write(join(repo, 'Dossier é', 'c d.txt'), 'c de main\n');
    commitAll(repo, 'Ajout SSO');
    await write(join(repo, 'b.txt'), 'b de main\n');
    commitAll(repo, 'Autre chose');
    const short = git(repo, 'rev-parse', '--short', 'main~1');
    expect(await service.lastMainCommit(repo, base, 'main', 'Dossier é/c d.txt')).toEqual({
      short,
      subject: 'Ajout SSO',
    });
    expect(await service.lastMainCommit(repo, base, 'main', 'a.txt')).toBeNull();
  });
});
