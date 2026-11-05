import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';

// fix-todo-diff-notifications — two fetches of the same branch of the same repository never overlap.

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

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-fetch-')));
  repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  git(root, 'init', '--bare', '-b', 'main', join(root, 'origin.git'));
  git(repo, 'remote', 'add', 'origin', join(root, 'origin.git'));
  git(repo, 'push', '-q', 'origin', 'main');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('GitService.fetchOrigin', () => {
  it('shares one fetch between concurrent callers, then fetches again once it is over', async () => {
    const service = new GitService({ env: gitEnv });
    const run = vi.spyOn(service as unknown as { run: () => Promise<unknown> }, 'run');
    const fetches = () => run.mock.calls.length;
    const together = await Promise.all([
      service.fetchOrigin(repo, 'main'),
      service.fetchOrigin(repo, 'main'),
      service.fetchOrigin(repo, 'main'),
    ]);
    expect(together).toEqual([true, true, true]);
    expect(fetches()).toBe(1);
    expect(await service.fetchOrigin(repo, 'main')).toBe(true);
    expect(fetches()).toBe(2);
  });
});
