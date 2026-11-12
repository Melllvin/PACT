import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { parseUnifiedDiff } from '../../shared/diff';
import type { ChangedFile, ConflictFile, FileDiff } from '../../shared/review';
import { parseNumstat, parseRaw } from './diff-output';

// research.md R7 — the git CLI through execFile/spawn (never a shell), tested on real repositories.

const execFileAsync = promisify(execFile);

/** A branch name that git accepts and that can never read as an option or a refspec trick. */
function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('@{') &&
    name !== '@' &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f~^:?*[\\]/.test(name) &&
    name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
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
/** One file of a tree: its mode and blob. */
export type TreeEntry = { mode: string; oid: string };
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

/** A call to the network gives up after this long. */
const REMOTE_TIMEOUT_MS = 30_000;

const exitCode = (error: unknown) => (error as { code?: unknown }).code;

/** Git prints `/`-separated and sometimes 8.3 short paths on Windows: compare canonical paths. */
const canonical = (path: string) => realpathSync.native(resolve(path));

/**
 * Two paths name the same folder: resolved, `/` and `\\` alike, the drive letter's case ignored on
 * Windows (git writes `C:/Users/…`, a native path is `C:\\Users\\…`).
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flavour = platform === 'win32' ? win32 : posix;
  const norm = (path: string) => {
    const resolved = flavour.resolve(path).replaceAll('\\', '/');
    return platform === 'win32' ? resolved.replace(/^[a-z]:/i, (d) => d.toLowerCase()) : resolved;
  };
  return norm(a) === norm(b);
}

export class GitService {
  private readonly env: Env | undefined;
  private readonly fetching = new Map<string, Promise<boolean>>();

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

  private run(cwd: string, args: string[], env: Env = {}, timeout?: number) {
    return execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      ...(timeout === undefined ? {} : { timeout }),
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

  /**
   * The best main branch known right now, with no network: the default branch of origin
   * (`origin/HEAD`), then `main` or `master` on origin, then locally, and only then the current
   * branch; never the branch the root folder happens to be on while one of those exists.
   * `settled` is false while origin could still tell better (`remoteDefaultBranch`).
   */
  async knownDefaultBranch(path: string): Promise<{ branch: string; settled: boolean }> {
    const quiet = async (args: string[]) => {
      try {
        return (await this.git(path, args)).trim();
      } catch {
        return '';
      }
    };
    const known = await quiet(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (known.startsWith('origin/'))
      return { branch: known.slice('origin/'.length), settled: true };
    const hasOrigin = (await quiet(['remote'])).split('\n').includes('origin');
    if (hasOrigin) {
      for (const name of ['main', 'master']) {
        if (await this.remoteBranchExists(path, name)) return { branch: name, settled: false };
      }
    }
    for (const name of ['main', 'master']) {
      if (await this.branchExists(path, name)) return { branch: name, settled: !hasOrigin };
    }
    return { branch: await this.currentBranch(path), settled: !hasOrigin };
  }

  /**
   * Asks origin for its default branch (`git remote show origin`): slow on a filtered network, so
   * never awaited by an opening or a launch. `null` when it cannot tell.
   */
  async remoteDefaultBranch(path: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(
        path,
        ['remote', 'show', 'origin'],
        { GIT_TERMINAL_PROMPT: '0' },
        REMOTE_TIMEOUT_MS,
      );
      const shown = /^\s*HEAD branch: (\S+)\s*$/m.exec(stdout)?.[1];
      return shown && shown !== '(unknown)' ? shown : null;
    } catch {
      return null;
    }
  }

  /** Whether `origin/<branch>` is known here. */
  async remoteBranchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await this.git(repo, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Brings `origin/<branch>` up to date, that branch only: no local branch, HEAD or worktree moves.
   * `false`, without throwing, when it fails (network down, no origin): the last one known stays.
   */
  fetchOrigin(cwd: string, branch: string): Promise<boolean> {
    // Two fetches of the same branch of the same repository never overlap: they share one.
    const key = `${cwd}\u0000${branch}`;
    const running = this.fetching.get(key);
    if (running) return running;
    const started = this.fetchNow(cwd, branch).finally(() => {
      this.fetching.delete(key);
    });
    this.fetching.set(key, started);
    return started;
  }

  private fetchNow(cwd: string, branch: string): Promise<boolean> {
    return this.fetchRefs(cwd, [branch]);
  }

  /**
   * 008 R13 — one explicit refspec per branch, nothing else: never `refs/pull/*`, never `--all`, no
   * tag. `false`, without throwing, when it fails.
   */
  async fetchRefs(cwd: string, branches: readonly string[]): Promise<boolean> {
    try {
      await this.run(
        cwd,
        [
          '-c',
          'gc.auto=0',
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--quiet',
          'origin',
          ...branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`),
        ],
        { GIT_TERMINAL_PROMPT: '0' },
        REMOTE_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 008 R5 — `commit` replayed on `onto` in a temporary detached worktree (`dir`), hooks off: the
   * worktree of the dev is never touched. `commit` is the result R, or null with the conflicting
   * files; nothing is left behind either way. `onto` already holding `commit`: R is `commit`.
   */
  async rebaseOnto(
    repo: string,
    { commit, onto, dir }: { commit: string; onto: string; dir: string },
  ): Promise<{ commit: string | null; conflicts: string[] }> {
    if (await this.isAncestor(repo, commit, onto)) return { commit, conflicts: [] };
    const base = await this.mergeBase(repo, commit, onto);
    const noHooks = await mkdtemp(join(tmpdir(), 'pact-no-hooks-'));
    const config = ['-c', `core.hooksPath=${noHooks}`, '-c', 'commit.gpgsign=false'];
    await mkdir(dirname(dir), { recursive: true });
    try {
      await this.git(repo, [...config, 'worktree', 'add', '--detach', dir, commit]);
      try {
        await this.git(dir, [...config, 'rebase', '--onto', onto, base]);
        return { commit: await this.git(dir, ['rev-parse', 'HEAD']), conflicts: [] };
      } catch (error) {
        const conflicts = (await this.git(dir, ['diff', '--name-only', '--diff-filter=U']))
          .split('\n')
          .filter((path) => path !== '');
        if (conflicts.length === 0) throw error;
        await this.git(dir, [...config, 'rebase', '--abort']).catch(() => undefined);
        return { commit: null, conflicts };
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(noHooks, { recursive: true, force: true });
      await this.git(repo, ['worktree', 'prune']);
    }
  }

  /** 008 FR-008 — whether the repository has a remote called `origin`: without one, no PR is possible. */
  async hasOrigin(repo: string): Promise<boolean> {
    try {
      return (await this.git(repo, ['remote'])).split('\n').includes('origin');
    } catch {
      return false;
    }
  }

  /**
   * 008 R5 — `commit` checked out detached in `dir`, a place of PACT's own (the tests run on the
   * rebased commit there). The caller removes it with `removeDetached`.
   */
  async addDetached(repo: string, dir: string, commit: string): Promise<void> {
    await mkdir(dirname(dir), { recursive: true });
    await this.git(repo, ['worktree', 'add', '--detach', dir, commit]);
  }

  /** Removes what `addDetached` made, whatever the tests left in it. */
  async removeDetached(repo: string, dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await this.git(repo, ['worktree', 'prune']);
  }

  /** 008 R10 — whether `ref` holds a workflow of GitHub Actions (`.github/workflows/*.yml`). */
  async hasWorkflows(cwd: string, ref: string): Promise<boolean> {
    try {
      const out = await this.gitRaw(cwd, [
        'ls-tree',
        '--name-only',
        ref,
        '--',
        '.github/workflows/',
      ]);
      return out.split('\n').some((path) => /\.ya?ml$/i.test(path));
    } catch {
      return false;
    }
  }

  private async isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
    try {
      await this.git(cwd, ['merge-base', '--is-ancestor', ancestor, of]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 008 R7 — `commit` pushed as `branch`, only if the remote still holds `expected` (`null`: the
   * branch is not there). `false` when the lease or the network refuses; the remote is then as it was.
   */
  async pushBranch(
    repo: string,
    { commit, branch, expected }: { commit: string; branch: string; expected: string | null },
  ): Promise<boolean> {
    try {
      await this.run(
        repo,
        [
          'push',
          '--quiet',
          'origin',
          `${commit}:refs/heads/${branch}`,
          `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`,
        ],
        { GIT_TERMINAL_PROMPT: '0' },
        REMOTE_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The head of `branch` on origin, read without fetching; null when absent or unreachable. */
  async remoteBranchHead(repo: string, branch: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(
        repo,
        ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
        { GIT_TERMINAL_PROMPT: '0' },
        REMOTE_TIMEOUT_MS,
      );
      return stdout.trim().split(/\s/)[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * 008 R18 — the remote branch deleted only if it is still at `expected` (the merged head): ONE push
   * that carries its own lease. `false` when the name or the sha is not valid, or the lease/network
   * refuses; the remote is then as it was.
   */
  async deleteRemoteBranch(repo: string, branch: string, expected: string): Promise<boolean> {
    if (!isSafeBranchName(branch) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(expected)) return false;
    try {
      await this.run(
        repo,
        [
          'push',
          '--quiet',
          `--force-with-lease=refs/heads/${branch}:${expected}`,
          '--',
          'origin',
          `:refs/heads/${branch}`,
        ],
        { GIT_TERMINAL_PROMPT: '0' },
        REMOTE_TIMEOUT_MS,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 008 R17 — what a worktree holds besides its commit: the changed files (staged, unstaged,
   * deleted), the untracked ones, the ignored `.env*` and the other ignored paths (`node_modules/`,
   * collapsed). The ignored ones never make a worktree « dirty », but `.env*` must not be lost.
   */
  async statusIgnored(cwd: string): Promise<{
    modified: string[];
    untracked: string[];
    ignoredEnv: string[];
    ignoredOther: string[];
  }> {
    const out = await this.gitRaw(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '--untracked-files=all',
    ]);
    const result = {
      modified: [] as string[],
      untracked: [] as string[],
      ignoredEnv: [] as string[],
      ignoredOther: [] as string[],
    };
    const entries = out.split('\0');
    for (let entry = entries.shift(); entry !== undefined; entry = entries.shift()) {
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      // A rename or a copy is followed by its origin.
      if (/[RC]/.test(code)) entries.shift();
      if (code === '??') result.untracked.push(path);
      else if (code === '!!') {
        const name = posix.basename(path);
        (name.startsWith('.env') && !path.endsWith('/')
          ? result.ignoredEnv
          : result.ignoredOther
        ).push(path);
      } else result.modified.push(path);
    }
    return result;
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
    await this.exclude(repo, EXCLUDE_LINE);
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
    try {
      await this.git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
    } catch (error) {
      if (!force) throw error;
      // On Windows, a process just stopped may hold a file of the worktree a moment longer: git
      // unregisters the worktree but leaves its folder. Remove it again, then forget the entry.
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await this.git(repo, ['worktree', 'prune']);
    }
    await this.git(repo, ['branch', '-D', branch]);
  }

  /**
   * 008 R17 — `git worktree remove <path>` and nothing else: the branch stays. Without `force` git
   * itself refuses a worktree that is locked or holds a modified or untracked file (a second guard).
   * A folder that is already gone is not an error: its entry is forgotten (`prune`, which leaves a
   * locked one alone).
   */
  async removeWorktreeDir(repo: string, path: string, force = false): Promise<void> {
    if (!(await exists(path))) {
      // Not a global `git worktree prune`: another worktree may be missing only for now (a disk
      // that is not mounted) and must stay registered. Clear this path's own entry (008 R2).
      await this.clearWorktreeEntry(repo, path);
      return;
    }
    await this.git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  }

  /** Drops the administrative entry (`<git-dir>/worktrees/<name>`) of the worktree at `path`, and only it. */
  private async clearWorktreeEntry(repo: string, path: string): Promise<void> {
    const common = (
      await this.git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    const admin = join(common, 'worktrees');
    let names: string[];
    try {
      names = await readdir(admin);
    } catch {
      return; // no linked worktree at all
    }
    for (const name of names) {
      let gitdir: string;
      try {
        gitdir = (await readFile(join(admin, name, 'gitdir'), 'utf8')).trim();
      } catch {
        continue;
      }
      // `gitdir` holds `<worktree>/.git`.
      if (samePath(dirname(gitdir), path)) {
        await rm(join(admin, name), { recursive: true, force: true });
        return;
      }
    }
  }

  /** `git branch -D`: the caller has checked that nothing is lost (008 R17). */
  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.git(repo, ['branch', '-D', '--', branch]);
  }

  /** The subjects of the commits of `head` that `base` does not hold (008 R17), newest first. */
  async commitsNotIn(cwd: string, head: string, base: string): Promise<string[]> {
    // `%h %s`: a commit with an empty subject still makes a line, so the count is right.
    const out = await this.git(cwd, ['log', '--format=%h %s', `${base}..${head}`, '--']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(line.indexOf(' ') + 1));
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

  /** 002 R6 — the file `path` of `treeish`, or null when it has none. */
  async entry(cwd: string, treeish: string, path: string): Promise<TreeEntry | null> {
    const out = await this.gitRaw(cwd, [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      '--full-tree',
      treeish,
      '--',
      path,
    ]);
    // `<mode> <type> <oid>\t<path>\0`
    const record = out.split('\0').find((line) => line.slice(line.indexOf('\t') + 1) === path);
    if (!record) return null;
    const [mode = '', , oid = ''] = record.slice(0, record.indexOf('\t')).split(' ');
    return { mode, oid };
  }

  /** The content of a blob, as stored. */
  async readBlob(cwd: string, oid: string): Promise<string> {
    return this.gitRaw(cwd, ['cat-file', 'blob', oid]);
  }

  /** 002 R6 — `content` written as a blob of the repository. */
  async writeBlob(cwd: string, content: string): Promise<string> {
    const run = this.run(cwd, ['hash-object', '-w', '--stdin']);
    (run.child.stdin as Writable).end(content);
    return (await run).stdout.trim();
  }

  /**
   * 002 R6 — `tree` with some files replaced (`null` removes one), through a temporary index:
   * no index or file of the repository is touched.
   */
  async replaceInTree(
    cwd: string,
    tree: string,
    changes: { path: string; entry: TreeEntry | null }[],
  ): Promise<string> {
    const temporary = join(tmpdir(), `pact-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: temporary };
    try {
      await this.git(cwd, ['read-tree', tree], env);
      const lines = changes.map(({ path, entry }) =>
        entry === null ? `0 ${'0'.repeat(40)}\t${path}` : `${entry.mode} ${entry.oid}\t${path}`,
      );
      const run = this.run(cwd, ['update-index', '-z', '--index-info'], env);
      (run.child.stdin as Writable).end(lines.map((line) => `${line}\0`).join(''));
      await run;
      return await this.git(cwd, ['write-tree'], env);
    } finally {
      await rm(temporary, { force: true });
    }
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

  /**
   * Adds `line` to the exclude file of `repo`, once. `.git` may be a file (linked worktree,
   * submodule): the exclude file lives in the common dir, shared by the worktrees.
   */
  async exclude(repo: string, line: string): Promise<void> {
    const commonDir = resolve(repo, await this.git(repo, ['rev-parse', '--git-common-dir']));
    const file = join(commonDir, 'info', 'exclude');
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // A fresh repository may have no exclude file yet.
    }
    if (text.split(/\r?\n/).includes(line)) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
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
