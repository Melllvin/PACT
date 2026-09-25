import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// research.md R7 — the git CLI through execFile/spawn (never a shell), tested on real repositories.

const execFileAsync = promisify(execFile);
const EXCLUDE_LINE = '/.worktrees/';
const MAX_OUTPUT = 16 * 1024 * 1024;

export type CloneProgress = { percent: number; phase: string };
export type Worktree = { path: string; branch: string };
type Env = Record<string, string | undefined>;

/** Git prints `/`-separated and sometimes 8.3 short paths on Windows: compare canonical paths. */
const canonical = (path: string) => realpathSync.native(resolve(path));

export class GitService {
  private readonly env: Env | undefined;

  constructor({ env }: { env?: Env } = {}) {
    this.env = env;
  }

  private async git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: this.env,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
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
