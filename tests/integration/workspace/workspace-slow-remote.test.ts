import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

// fix-todo-diff-notifications — opening and restoring never wait for the network: the best main
// branch known is used at once, origin is asked in the background. The remote is simulated: it
// answers when the test says so, with no real delay.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** A git whose origin answers only when `answer` is called (or never). */
class SilentRemote extends GitService {
  readonly asked: string[] = [];
  failing = false;
  private readonly waiting: ((branch: string | null) => void)[] = [];

  override remoteDefaultBranch(path: string): Promise<string | null> {
    this.asked.push(path);
    if (this.failing) return Promise.reject(new Error('remote en panne'));
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  answer(branch: string | null) {
    for (const resolve of this.waiting.splice(0)) resolve(branch);
  }
}

let root: string;
let services: WorkspaceService[];
let remote: SilentRemote;
let changed: [string, string][];

const service = (callbacks = true) => {
  const created = new WorkspaceService({
    git: remote,
    stores: openStores(join(root, 'userData')),
    ...(callbacks
      ? { onMainBranch: (id: string, branch: string) => changed.push([id, branch]) }
      : {}),
  });
  services.push(created);
  return created;
};

/** A clone of a bare origin with `main` and `develop`, its origin/HEAD unknown, on a feature branch. */
const clone = async (name: string) => {
  const seed = join(root, `${name}-seed`);
  const origin = join(root, `${name}.git`);
  const repo = join(root, name);
  await mkdir(seed, { recursive: true });
  git(seed, 'init', '-b', 'main');
  await writeFile(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'branch', 'develop');
  git(root, 'init', '--bare', '-b', 'develop', origin);
  git(seed, 'push', '-q', origin, 'main:main', 'develop:develop');
  git(root, 'clone', '-q', origin, repo);
  git(repo, 'remote', 'set-head', 'origin', '-d');
  git(repo, 'checkout', '-q', '-b', 'feature');
  return repo;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-ws-slow-')));
  services = [];
  changed = [];
  remote = new SilentRemote({ env: gitEnv });
});

afterEach(async () => {
  for (const created of services) created.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a remote that does not answer', () => {
  it('does not hold the opening: the best value known is used, origin being asked after', async () => {
    const repo = await clone('repo');
    const workspace = await service().open(repo);
    expect(workspace.mainBranch).toBe('main');
    expect(remote.asked).toEqual([workspace.path]);
    expect(changed).toEqual([]);
  });

  it('changes the workspace, and tells it, when origin names another main branch', async () => {
    const repo = await clone('repo');
    const opened = service();
    const { id } = await opened.open(repo);
    remote.answer('develop');
    await vi.waitFor(() => {
      expect(changed).toEqual([[id, 'develop']]);
    });
    expect(opened.get(id)?.mainBranch).toBe('develop');
    expect((await opened.recents())[0]?.branch).toBe('develop');
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  });

  it.each([null, 'main'])('changes nothing when origin answers %s', async (answer) => {
    const repo = await clone('repo');
    const opened = service();
    const { id } = await opened.open(repo);
    remote.answer(answer);
    await settle();
    expect(opened.get(id)?.mainBranch).toBe('main');
    expect(changed).toEqual([]);
  });

  it('survives a remote that fails, and keeps the main branch known', async () => {
    const repo = await clone('repo');
    remote.failing = true;
    const opened = service();
    const { id } = await opened.open(repo);
    await settle();
    expect(opened.get(id)?.mainBranch).toBe('main');
    expect(changed).toEqual([]);
  });

  it('works without any callback: the main branch changes and a vanished folder is noticed', async () => {
    const repo = await clone('repo');
    const opened = service(false);
    const { id } = await opened.open(repo);
    remote.answer('develop');
    await vi.waitFor(() => {
      expect(opened.get(id)?.mainBranch).toBe('develop');
    });
    await rm(repo, { recursive: true, force: true });
    await opened.checkAvailability();
    expect(opened.get(id)?.status).toBe('unavailable');
  });

  it('forgets an answer that comes after the workspace was closed', async () => {
    const repo = await clone('repo');
    const opened = service();
    const { id } = await opened.open(repo);
    await opened.close(id);
    remote.answer('develop');
    await settle();
    expect(changed).toEqual([]);
  });

  it('does not ask origin for a repository without one, nor when origin/HEAD is known', async () => {
    const repo = await clone('repo');
    git(repo, 'remote', 'set-head', 'origin', 'main');
    const local = join(root, 'local');
    await mkdir(local);
    git(local, 'init', '-b', 'main');
    await writeFile(join(local, 'a.txt'), 'a\n');
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'initial');
    const opened = service();
    await opened.open(repo);
    await opened.open(local);
    expect(remote.asked).toEqual([]);
  });

  it('does not hold the restoration of several workspaces either', async () => {
    const [a, b] = [await clone('a'), await clone('b')];
    const first = service();
    await first.open(a);
    await first.open(b);
    first.dispose();
    remote = new SilentRemote({ env: gitEnv });
    const restarted = service();
    const restored = await restarted.restore();
    expect(restored.map((ws) => ws.mainBranch)).toEqual(['main', 'main']);
    expect(remote.asked).toHaveLength(2);
    remote.answer('develop');
    await vi.waitFor(() => {
      expect(restarted.list().map((ws) => ws.mainBranch)).toEqual(['develop', 'develop']);
    });
  });
});

describe('GitService.remoteDefaultBranch', () => {
  it('reads the default branch of origin, and gives null when it cannot tell', async () => {
    const real = new GitService({ env: gitEnv });
    const repo = await clone('repo');
    expect(await real.remoteDefaultBranch(repo)).toBe('develop');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    expect(await real.remoteDefaultBranch(repo)).toBeNull();
  });

  it('gives null for an origin whose default branch does not exist', async () => {
    const real = new GitService({ env: gitEnv });
    const repo = await clone('repo');
    git(join(root, 'repo.git'), 'symbolic-ref', 'HEAD', 'refs/heads/absente');
    expect(await real.remoteDefaultBranch(repo)).toBeNull();
  });
});
