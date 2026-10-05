import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { parseUnifiedDiff } from '../../shared/diff';
import type { ChangedFile, ConflictFile, FileDiff } from '../../shared/review';
import { parseNumstat, parseRaw } from './diff-output';

// research.md R7 — the git CLI through execFile/spawn (never a shell), tested on real repositories.

const execFileAsync = promisify(execFile);
const EXCLUDE_LINE = '/.worktrees/';
const MAX_OUTPUT = 16 * 1024 * 1024;
/** Above these, a file is listed without its line diff (002 R2). */
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_DIFF_LINES = 5000;
/** The unreferenced snapshot commit needs an identity, whatever the user configured. */
const SNAPSHOT_IDENTITY = ['-c', 'user.name=PACT', '-c', 'user.email=pact@localhost'];

export type CloneProgress = { percent: number; phase: string };
export type Worktree = { path: string; branch: string };
export type Snapshot = { commit: string; tree: string };
export type DiffTarget = { base: string; tree: string; path: string; oldPath: string | null };
export type MergeConflict = { path: string; kind: ConflictFile['kind'] };
export type MergeResult = { tree: string; conflicts: MergeConflict[] };
export type CommitPlan = {
  /** The temporary worktree, removed whatever happens. */
  dir: string;
  onto: string;
  tree: string;
  /** Made a merge commit of `onto` and this commit. */
  merge?: string;
  message: string;
};
type Env = Record<string, string | undefined>;

/** 002 FR-021 — git refused to move the branch over local changes to these files. */
export class LocalChangesError extends Error {
  constructor(readonly files: string[]) {
    super(`Local changes would be overwritten: ${files.join(', ')}`);
  }
}

/** What git said when it failed, as it said it (FR-023). */
export function gitErrorOutput(error: unknown): string {
  const failure = error as { stderr?: string; stdout?: string; message: string };
  return failure.stderr?.trim() || failure.stdout?.trim() || failure.message;
}

const exitCode = (error: unknown) => (error as { code?: unknown }).code;

/** Git prints `/`-separated and sometimes 8.3 short paths on Windows: compare canonical paths. */
const canonical = (path: string) => realpathSync.native(resolve(path));

export class GitService {
  private readonly env: Env | undefined;

  constructor({ env }: { env?: Env } = {}) {
    this.env = env;
  }

  private async git(cwd: string, args: string[], env: Env = {}) {
    return (await this.gitRaw(cwd, args, env)).trim();
  }

  /** English messages (parsed, R2) and raw UTF-8 paths, whatever the user's locale and config. */
  private async gitRaw(cwd: string, args: string[], env: Env = {}) {
    return (await this.run(cwd, args, env)).stdout;
  }

  private run(cwd: string, args: string[], env: Env = {}) {
    return execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env: { ...(this.env ?? process.env), ...env, LC_ALL: 'C' },
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
  }

  async isRepo(path: string): Promise<boolean> {
    try {
      return (await this.git(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      return false;
    }
  }

  async repoRoot(path: string): Promise<string> {
    return canonical(await this.git(path, ['rev-parse', '--show-toplevel']));
  }

  async currentBranch(path: string): Promise<string> {
    return this.git(path, ['branch', '--show-current']);
  }

  async initRepo(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await this.git(path, ['init']);
  }

  /** Worktrees start from the committed base branch: local changes are not included. */
  async hasUncommittedChanges(path: string): Promise<boolean> {
    return (await this.git(path, ['status', '--porcelain'])).length > 0;
  }

  /**
   * Worktree `<repo>/.worktrees/<cli>-<position>`. Without a chosen `branch`, it gets the
   * provisional `agent/<cli>-<position>`, suffixed rather than reusing an existing branch; a
   * chosen branch that already exists makes git fail (the caller validates it first).
   */
  async addWorktree(
    repo: string,
    {
      cli,
      position,
      base,
      branch,
    }: { cli: string; position: number; base: string; branch?: string },
  ): Promise<Worktree> {
    await this.excludeWorktrees(repo);
    const name = `${cli}-${String(position)}`;
    if (branch !== undefined) {
      const path = await this.freePath(join(repo, '.worktrees', name));
      await this.git(repo, ['worktree', 'add', '-b', branch, path, base]);
      return { path, branch };
    }
    for (let attempt = 1; ; attempt++) {
      const suffix = attempt === 1 ? '' : `-${String(attempt)}`;
      const branch = `agent/${name}${suffix}`;
      const path = join(repo, '.worktrees', `${name}${suffix}`);
      if ((await this.branchExists(repo, branch)) || (await exists(path))) continue;
      await this.git(repo, ['worktree', 'add', '-b', branch, path, base]);
      return { path, branch };
    }
  }

  /** Fails on uncommitted work unless `force`: the caller asks the user first (FR-037). */
  async removeWorktree(
    repo: string,
    { path, branch, force = false }: Worktree & { force?: boolean },
  ): Promise<void> {
    await this.git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
    await this.git(repo, ['branch', '-D', branch]);
  }

  /** `git clone --progress`, streaming progress parsed from stderr. */
  clone(url: string, destination: string, onProgress: (p: CloneProgress) => void): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      // T114: `ext::` runs any command; refused even when the user's git config allows it.
      const args = [
        '-c',
        'protocol.ext.allow=never',
        'clone',
        '--progress',
        '--',
        url,
        destination,
      ];
      const child = spawn('git', args, {
        env: this.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_OUTPUT);
        for (const line of chunk.split(/[\r\n]+/)) {
          // Phases are localized (« Réception d'objets ») — match any label before `: NN%`.
          const match = /^(?:remote: )?([^:]+?):\s+(\d{1,3})%/u.exec(line.trim());
          if (match?.[1] && match[2]) onProgress({ phase: match[1], percent: Number(match[2]) });
        }
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(stderr.trim() || `git clone exited with code ${String(code)}`));
      });
    });
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 002 R1 — the worktree as it is (committed, uncommitted, untracked, ignored files left out),
   * written as an unreferenced commit on HEAD. A copy of the index is used: the agent's index,
   * files and branch are not touched.
   */
  async snapshot(worktree: string): Promise<Snapshot> {
    const index = resolve(worktree, await this.git(worktree, ['rev-parse', '--git-path', 'index']));
    const temporary = join(tmpdir(), `pact-index-${randomUUID()}`);
    try {
      if (await exists(index)) {
        await copyFile(index, temporary);
        // Git rereads a file whose stat matches its entry only when that entry is as recent as
        // the index itself (« racy git »): the copy keeps the index's mtime for that check.
        const { atime, mtime } = await stat(index);
        await utimes(temporary, atime, mtime);
      }
      const env = { GIT_INDEX_FILE: temporary };
      await this.git(worktree, ['add', '-A'], env);
      const tree = await this.git(worktree, ['write-tree'], env);
      const commit = await this.git(worktree, [
        ...SNAPSHOT_IDENTITY,
        'commit-tree',
        tree,
        '-p',
        'HEAD',
        '-m',
        'PACT review snapshot',
      ]);
      return { commit, tree };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async revParse(cwd: string, ref: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  }

  async treeOf(cwd: string, ref: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]);
  }

  /** Lines added and removed between two contents of a file (« Nouveaux changements », R9). */
  async diffBlobs(
    cwd: string,
    from: string,
    to: string,
  ): Promise<{ added: number; removed: number }> {
    const [counts] = parseNumstat(
      await this.gitRaw(cwd, ['diff', '--numstat', '-z', '--no-ext-diff', from, to]),
    ).values();
    return { added: counts?.added ?? 0, removed: counts?.removed ?? 0 };
  }

  async mergeBase(cwd: string, a: string, b: string): Promise<string> {
    return this.git(cwd, ['merge-base', a, b]);
  }

  /** 002 R2 — the files that differ between `base` and the snapshot `tree`, in git's path order. */
  async changedFiles(cwd: string, base: string, tree: string): Promise<ChangedFile[]> {
    const range = ['-M', '--no-ext-diff', base, tree];
    const [raw, numstat, ignoringCr] = await Promise.all([
      this.gitRaw(cwd, ['diff', '--raw', '-z', '--no-abbrev', ...range]),
      this.gitRaw(cwd, ['diff', '--numstat', '-z', ...range]),
      this.gitRaw(cwd, ['diff', '--numstat', '-z', '--ignore-cr-at-eol', ...range]),
    ]);
    const counts = parseNumstat(numstat);
    const countsIgnoringCr = parseNumstat(ignoringCr);
    const files = parseRaw(raw).map(({ status, path, oldPath, blob }): ChangedFile => {
      const { added, removed } = counts.get(path) ?? { added: 0, removed: 0 };
      const lines = (added ?? 0) + (removed ?? 0);
      const binary = added === null;
      const withoutCr = countsIgnoringCr.get(path);
      const eolOnly =
        !binary &&
        lines > 0 &&
        (withoutCr === undefined || (withoutCr.added === 0 && withoutCr.removed === 0));
      return {
        path,
        oldPath,
        status,
        added,
        removed,
        binary,
        tooLarge: lines > MAX_DIFF_LINES,
        eolOnly,
        blob,
      };
    });
    const sizes = await this.blobSizes(
      cwd,
      files.flatMap((f) => (f.blob ? [f.blob] : [])),
    );
    for (const file of files) {
      if (file.blob && (sizes.get(file.blob) ?? 0) > MAX_DIFF_BYTES) file.tooLarge = true;
    }
    return files;
  }

  /** 002 R2 — one file's diff, carriage returns at end of line ignored; no hunk when too big. */
  async fileDiff(cwd: string, { base, tree, path, oldPath }: DiffTarget): Promise<FileDiff> {
    const paths = oldPath === null ? [path] : [oldPath, path];
    const range = ['-M', '--no-ext-diff', '--no-textconv', base, tree, '--', ...paths];
    const side = (await this.objectExists(cwd, `${tree}:${path}`))
      ? `${tree}:${path}`
      : `${base}:${oldPath ?? path}`;
    const size = Number(await this.git(cwd, ['cat-file', '-s', side]));
    const [counts] = parseNumstat(
      await this.gitRaw(cwd, ['--literal-pathspecs', 'diff', '--numstat', '-z', ...range]),
    ).values();
    const lines = counts ? (counts.added ?? 0) + (counts.removed ?? 0) : 0;
    if (counts?.added === null || lines > MAX_DIFF_LINES || size > MAX_DIFF_BYTES) {
      return { path, hunks: [], size };
    }
    const text = await this.gitRaw(cwd, [
      '--literal-pathspecs',
      'diff',
      '--no-color',
      '--ignore-cr-at-eol',
      ...range,
    ]);
    return { path, hunks: parseUnifiedDiff(text), size };
  }

  /**
   * 002 R4 — `ours` and `theirs` merged in objects only: the result tree, conflict markers
   * included, and the conflicting paths. `base` replaces the merge base git would find.
   */
  async mergeTree(cwd: string, ours: string, theirs: string, base?: string): Promise<MergeResult> {
    const args = ['merge-tree', '--write-tree', '-z', '--no-messages'];
    if (base !== undefined) args.push('--merge-base', base);
    const out = await this.gitRaw(cwd, [...args, ours, theirs]).catch((error: unknown) => {
      // Exit 1 with a tree printed is a merge with conflicts; without, a bad argument.
      const { stdout } = error as { stdout: string };
      if (exitCode(error) === 1 && stdout !== '') return stdout;
      throw error;
    });
    // `<tree>\0`, then `<mode> <oid> <stage>\t<path>\0` per conflicting entry.
    const stages = new Map<string, string>();
    for (const entry of out.split('\0').slice(1)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      stages.set(path, (stages.get(path) ?? '') + entry.charAt(tab - 1));
    }
    return {
      tree: out.slice(0, out.indexOf('\0')),
      conflicts: [...stages].map(([path, found]) => ({
        path,
        kind: !found.includes('1') ? 'add-add' : found.length === 3 ? 'content' : 'delete-modify',
      })),
    };
  }

  /** 002 R4 — the last commit of `main` since `base` that touched `path`. */
  async lastMainCommit(
    cwd: string,
    base: string,
    main: string,
    path: string,
  ): Promise<{ short: string; subject: string } | null> {
    const out = await this.git(cwd, [
      '--literal-pathspecs',
      'log',
      '-1',
      '--format=%h%x00%s',
      `${base}..${main}`,
      '--',
      path,
    ]);
    if (out === '') return null;
    const cut = out.indexOf('\0');
    return { short: out.slice(0, cut), subject: out.slice(cut + 1) };
  }

  /**
   * 002 R5 — `tree` committed on top of `onto` by a real `git commit`, so the repository's
   * hooks run, in a temporary detached worktree. No branch moves. Returns the new commit.
   */
  async commitWithHooks(repo: string, { dir, onto, tree, merge, message }: CommitPlan) {
    await mkdir(dirname(dir), { recursive: true });
    await this.git(repo, ['worktree', 'add', '--detach', dir, onto]);
    try {
      // `-s ours` only records the second parent: the tree is the one given.
      if (merge !== undefined) {
        await this.git(dir, ['merge', '--no-ff', '--no-commit', '-s', 'ours', merge]);
      }
      await this.git(dir, ['read-tree', '-m', '-u', 'HEAD', tree]);
      const commit = this.run(dir, ['commit', '-q', '-F', '-']);
      (commit.child.stdin as Writable).end(message);
      await commit;
      return await this.git(dir, ['rev-parse', 'HEAD']);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await this.git(repo, ['worktree', 'prune']);
    }
  }

  /**
   * 002 R5 — the branch checked out in `cwd` fast-forwarded to `commit`, its files with it. Git
   * refuses before writing anything when local changes would be lost (FR-021).
   */
  async fastForward(cwd: string, commit: string): Promise<void> {
    try {
      await this.git(cwd, ['merge', '--ff-only', '-q', commit]);
    } catch (error) {
      // Git lists the files in the way one per line, indented by a tab.
      const files = gitErrorOutput(error)
        .split('\n')
        .filter((line) => line.startsWith('\t'))
        .map((line) => line.trim());
      if (files.length > 0) throw new LocalChangesError(files);
      throw error;
    }
  }

  /** 002 R5 — `branch` moved to `next` only if it is still at `expected` (FR-022). */
  async updateRef(cwd: string, branch: string, next: string, expected: string): Promise<void> {
    await this.git(cwd, ['update-ref', `refs/heads/${branch}`, next, expected]);
  }

  /** The folder where `branch` is checked out, if any, as a native path. */
  async worktreeOf(repo: string, branch: string): Promise<string | null> {
    const out = await this.gitRaw(repo, ['worktree', 'list', '--porcelain', '-z']);
    for (const record of out.split('\0\0')) {
      if (record.split('\0').includes(`branch refs/heads/${branch}`)) {
        return resolve(record.slice('worktree '.length, record.indexOf('\0')));
      }
    }
    return null;
  }

  /**
   * 002 R5 — the worktree put on `commit`, its files then set to `tree` and left as changes to
   * commit (« Conserver le worktree »). Pass `commit` as `tree` to carry nothing over.
   */
  async moveWorktree(worktree: string, commit: string, tree: string): Promise<void> {
    await this.git(worktree, ['reset', '-q', '--hard', commit]);
    await this.git(worktree, ['read-tree', '-u', '--reset', tree]);
    await this.git(worktree, ['reset', '-q']);
  }

  private async objectExists(cwd: string, object: string) {
    try {
      await this.git(cwd, ['cat-file', '-e', object]);
      return true;
    } catch {
      return false;
    }
  }

  private async blobSizes(cwd: string, blobs: string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (blobs.length === 0) return sizes;
    const run = this.run(cwd, ['cat-file', '--batch-check=%(objectname) %(objectsize)']);
    (run.child.stdin as Writable).end(`${blobs.join('\n')}\n`);
    const out = (await run).stdout;
    for (const line of out.split('\n')) {
      const [id, size] = line.split(' ');
      if (id && size) sizes.set(id, Number(size));
    }
    return sizes;
  }

  /** `path`, or `path-2`, `path-3`… when a leftover folder is in the way. */
  private async freePath(path: string) {
    for (let attempt = 1; ; attempt++) {
      const candidate = attempt === 1 ? path : `${path}-${String(attempt)}`;
      if (!(await exists(candidate))) return candidate;
    }
  }

  /** `.git` may be a file (linked worktree, submodule): the exclude file lives in the common dir. */
  private async excludeWorktrees(repo: string) {
    const commonDir = resolve(repo, await this.git(repo, ['rev-parse', '--git-common-dir']));
    const file = join(commonDir, 'info', 'exclude');
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // A fresh repository may have no exclude file yet.
    }
    if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`);
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
