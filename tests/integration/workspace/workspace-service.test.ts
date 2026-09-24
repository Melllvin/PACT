import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

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
let userData: string;
let clock: Date;
let events: { id: string; status: string }[];

const makeRepo = async (name: string, branch = 'main') => {
  const path = join(root, 'Mes Projets', name);
  await mkdir(path, { recursive: true });
  git(path, 'init', '-b', branch);
  await writeFile(join(path, 'README.md'), '# test\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'initial');
  return path;
};

/** macOS FSEvents streams start asynchronously and miss changes made in their first moments. */
const watcherStartup = () => new Promise((r) => setTimeout(r, 300));

const createService = () =>
  new WorkspaceService({
    git: new GitService({ env: gitEnv }),
    stores: openStores(userData),
    now: () => clock,
    onStatus: (event) => events.push(event),
  });

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-ws-')));
  userData = join(root, 'userData');
  clock = new Date('2026-09-24T10:00:00.000Z');
  events = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('WorkspaceService.open', () => {
  it('opens a repository as an empty workspace identified by a hash of its real path', async () => {
    const repo = await makeRepo('Développement');
    const workspace = await createService().open(repo);
    expect(workspace).toMatchObject({
      id: createHash('sha256').update(repo).digest('hex').slice(0, 16),
      path: repo,
      name: 'Développement',
      mainBranch: 'main',
      agents: [],
      freeTerminals: [],
      status: 'available',
      lastOpenedAt: clock.toISOString(),
    });
  });

  it('opens the repository root when given one of its subfolders', async () => {
    const repo = await makeRepo('app');
    await mkdir(join(repo, 'src'));
    expect((await createService().open(join(repo, 'src'))).path).toBe(repo);
  });

  it('records the branch checked out in the main repository', async () => {
    const repo = await makeRepo('develop-repo', 'develop');
    expect((await createService().open(repo)).mainBranch).toBe('develop');
  });

  it('refuses a folder that is not a Git repository (NOT_A_REPO)', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    await expect(createService().open(plain)).rejects.toMatchObject({ code: 'NOT_A_REPO' });
  });

  it('never opens the same repository twice and points to the existing tab (FR-004)', async () => {
    const repo = await makeRepo('app');
    const service = createService();
    const first = await service.open(repo);
    await expect(service.open(join(repo, '.'))).rejects.toMatchObject({
      code: 'ALREADY_OPEN',
      workspaceId: first.id,
    });
    expect(service.list()).toHaveLength(1);
  });

  it('initializes a repository in a plain folder, then opens it', async () => {
    const plain = join(root, 'nouveau');
    await mkdir(plain);
    const workspace = await createService().initRepo(plain);
    expect(workspace.path).toBe(plain);
    expect(git(plain, 'rev-parse', '--is-inside-work-tree')).toBe('true');
  });
});

describe('recent projects', () => {
  it('lists recents newest first', async () => {
    const service = createService();
    const [a, b] = [await makeRepo('a'), await makeRepo('b')];
    await service.open(a);
    clock = new Date('2026-09-25T10:00:00.000Z');
    await service.open(b);
    expect((await service.recents()).map((r) => r.name)).toEqual(['b', 'a']);
  });

  // 22 real repositories: allow for slow disks and parallel test files.
  it('keeps at most 20 recents', { timeout: 30_000 }, async () => {
    const service = createService();
    for (let i = 0; i < 22; i++) {
      clock = new Date(Date.UTC(2026, 8, 1, i));
      const { id } = await service.open(await makeRepo(`repo-${String(i)}`));
      await service.close(id);
    }
    const recents = await service.recents();
    expect(recents).toHaveLength(20);
    expect(recents[0]?.name).toBe('repo-21');
  });

  it('counts the worktrees kept under .worktrees/', async () => {
    const repo = await makeRepo('app');
    await mkdir(join(repo, '.worktrees', 'codex-1'), { recursive: true });
    await mkdir(join(repo, '.worktrees', 'claude-code-2'), { recursive: true });
    const service = createService();
    await service.open(repo);
    expect((await service.recents())[0]).toMatchObject({ name: 'app', keptWorktrees: 2 });
  });

  it('updates a recent instead of duplicating it', async () => {
    const repo = await makeRepo('app');
    const service = createService();
    const { id } = await service.open(repo);
    await service.close(id);
    clock = new Date('2026-09-30T10:00:00.000Z');
    await service.open(repo);
    const recents = await service.recents();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.lastOpenedAt).toBe(clock.toISOString());
  });
});

describe('availability', () => {
  it('marks a workspace unavailable when its folder disappears, and back when it returns', async () => {
    const repo = await makeRepo('app');
    const service = createService();
    const { id } = await service.open(repo);

    await rename(repo, `${repo}-moved`);
    await service.checkAvailability();
    expect(service.get(id)?.status).toBe('unavailable');
    expect(events).toEqual([{ id, status: 'unavailable' }]);

    await rename(`${repo}-moved`, repo);
    await service.checkAvailability();
    expect(service.get(id)?.status).toBe('available');
    expect(events.at(-1)).toEqual({ id, status: 'available' });
  });

  it('reacts to a folder disappearing right away, without waiting for the periodic check', async () => {
    const repo = await makeRepo('app');
    const service = createService();
    const { id } = await service.open(repo);
    service.startWatching(3_600_000); // the periodic check cannot be what reacts here
    try {
      await watcherStartup();
      await rename(repo, `${repo}-moved`);
      for (let i = 0; i < 250 && events.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(events).toEqual([{ id, status: 'unavailable' }]);
    } finally {
      service.dispose();
    }
  });

  it('watches workspaces opened after watching started, and stops watching closed ones', async () => {
    const service = createService();
    service.startWatching(3_600_000);
    try {
      const repo = await makeRepo('late');
      const { id } = await service.open(repo);
      await service.close(id);
      await rename(repo, `${repo}-moved`);
      await new Promise((r) => setTimeout(r, 300));
      expect(events).toEqual([]);

      const other = await makeRepo('other');
      const opened = await service.open(other);
      await watcherStartup();
      await rename(other, `${other}-moved`);
      for (let i = 0; i < 250 && events.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(events).toEqual([{ id: opened.id, status: 'unavailable' }]);
    } finally {
      service.dispose();
    }
  });

  it('only reports status changes', async () => {
    const service = createService();
    await service.open(await makeRepo('app'));
    await service.checkAvailability();
    await service.checkAvailability();
    expect(events).toEqual([]);
  });

  it('checks periodically once watching starts, and stops on dispose', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const service = createService();
      const check = vi.spyOn(service, 'checkAvailability').mockResolvedValue();
      service.startWatching(2000);
      vi.advanceTimersByTime(6000);
      expect(check).toHaveBeenCalledTimes(3);
      service.dispose();
      vi.advanceTimersByTime(6000);
      expect(check).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('persistence across restarts (FR-005)', () => {
  it('restores the workspaces that were open, in order', async () => {
    const [a, b] = [await makeRepo('a'), await makeRepo('b')];
    const first = createService();
    await first.open(a);
    await first.open(b);

    const restarted = createService();
    const restored = await restarted.restore();
    expect(restored.map((w) => w.name)).toEqual(['a', 'b']);
    expect(restarted.list()).toHaveLength(2);
  });

  it('does not restore a closed workspace, which stays in the recents', async () => {
    const repo = await makeRepo('app');
    const first = createService();
    const { id } = await first.open(repo);
    await first.close(id);

    const restarted = createService();
    expect(await restarted.restore()).toEqual([]);
    expect((await restarted.recents()).map((r) => r.name)).toEqual(['app']);
  });

  it('restores a workspace whose folder is gone as unavailable', async () => {
    const repo = await makeRepo('app');
    await createService().open(repo);
    await rm(repo, { recursive: true, force: true });

    const restored = await createService().restore();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe('unavailable');
  });

  it('closing an unknown workspace is a NOT_FOUND error', async () => {
    await expect(createService().close('abc123')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('WorkspaceService.update', () => {
  it('saves a change to an open workspace so it survives a restart', async () => {
    const repo = await makeRepo('app');
    const service = createService();
    const { id } = await service.open(repo);
    const permissionOverride = { level: 'always-ask', autoResume: true, scope: 'project' } as const;
    await service.update(id, (workspace) => ({ ...workspace, permissionOverride }));
    expect(service.get(id)?.permissionOverride).toEqual(permissionOverride);
    const [restored] = await createService().restore();
    expect(restored?.permissionOverride).toEqual(permissionOverride);
  });

  it('refuses an unknown workspace (NOT_FOUND)', async () => {
    await expect(createService().update('abc', (w) => w)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
