import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export class GitService {
  private async git(cwd: string, args: string[]) {
    return (await exec('git', args, { cwd })).stdout.trim();
  }
  async isRepo(path: string) {
    try {
      return (await this.git(path, ['rev-parse', '--is-inside-work-tree'])) === 'true';
    } catch {
      return false;
    }
  }
  currentBranch(path: string) {
    return this.git(path, ['branch', '--show-current']);
  }
  async initRepo(path: string) {
    await mkdir(path, { recursive: true });
    await this.git(path, ['init']);
  }
  async hasChanges(path: string) {
    return (await this.git(path, ['status', '--porcelain'])).length > 0;
  }
  async addWorktree(repo: string, cli: string, position: number, base: string) {
    await this.excludeWorktrees(repo);
    let suffix = 0;
    let branch = `agent/${cli}-${position}`;
    while (await this.branchExists(repo, branch)) branch = `agent/${cli}-${position}-${++suffix}`;
    const path = join(repo, '.worktrees', `${cli}-${position}${suffix ? `-${suffix}` : ''}`);
    await mkdir(dirname(path), { recursive: true });
    await this.git(repo, ['worktree', 'add', '-b', branch, path, base]);
    return { path, branch };
  }
  async removeWorktree(repo: string, path: string, branch: string) {
    await this.git(repo, ['worktree', 'remove', '--force', path]);
    await this.git(repo, ['branch', '-D', branch]);
  }
  async clone(url: string, destination: string) {
    await exec('git', ['clone', '--progress', url, destination]);
  }
  private async branchExists(repo: string, branch: string) {
    try {
      await this.git(repo, ['show-ref', '--verify', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }
  private async excludeWorktrees(repo: string) {
    const file = join(repo, '.git', 'info', 'exclude');
    await mkdir(dirname(file), { recursive: true });
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // The exclude file is optional in a newly initialized repository.
    }
    if (!text.split(/\r?\n/).includes('/.worktrees/'))
      await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}/.worktrees/\n`);
  }
}
