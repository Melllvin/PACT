import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

// fix-todo-diff-notifications — the main branch of a workspace is the default branch of origin,
// never the branch the root folder happens to be on. Temporary repositories only.

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
let services: WorkspaceService[];

const createService = () => {
  const service = new WorkspaceService({
    git: new GitService({ env: gitEnv }),
    stores: openStores(join(root, 'userData')),
  });
  services.push(service);
  return service;
};

const commit = async (cwd: string, file = 'README.md') => {
  await writeFile(join(cwd, file), `${file}\n`);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', `add ${file}`);
};

/** A bare origin holding `branches`, the first being its default, and a clone of it. */
const cloneOfOrigin = async (branches: string[] = ['main']) => {
  const [first = 'main'] = branches;
  const seed = join(root, 'seed');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'Mes Projets', 'repo');
  await mkdir(seed, { recursive: true });
  git(seed, 'init', '-b', first);
  await commit(seed);
  for (const branch of branches.slice(1)) git(seed, 'branch', branch);
  git(root, 'init', '--bare', '-b', first, origin);
  git(seed, 'push', '-q', origin, ...branches.map((b) => `${b}:${b}`));
  git(root, 'clone', '-q', origin, repo);
  return { origin, repo };
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-ws-main-')));
  services = [];
});

afterEach(async () => {
  for (const service of services) service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the main branch comes from origin/HEAD', () => {
  it('is the default branch of origin, not the branch the root folder is on', async () => {
    const { repo } = await cloneOfOrigin();
    git(repo, 'checkout', '-q', '-b', '002-phase-5-us3-comments');
    await commit(repo, 'feature.txt');
    expect((await createService().open(repo)).mainBranch).toBe('main');
    // The root folder is not touched.
    expect(git(repo, 'branch', '--show-current')).toBe('002-phase-5-us3-comments');
  });

  it('uses the known origin/HEAD even when the network is down', async () => {
    const { repo } = await cloneOfOrigin();
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    expect((await createService().open(repo)).mainBranch).toBe('main');
  });

  it('recalculates a main branch saved wrong, without any action and without moving the root', async () => {
    const { repo } = await cloneOfOrigin();
    git(repo, 'checkout', '-q', '-b', 'feature');
    const first = createService();
    const { id } = await first.open(repo);
    first.dispose();
    const stores = openStores(join(root, 'userData'));
    const saved = await stores.workspace(id).read();
    await stores
      .workspace(id)
      .write({ ...saved, mainBranch: 'feature' } as NonNullable<typeof saved>);
    expect((await createService().open(repo)).mainBranch).toBe('main');
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  });
});

describe('an origin without a known origin/HEAD', () => {
  it('asks origin and takes its default branch', async () => {
    const { repo } = await cloneOfOrigin(['main', 'develop']);
    git(repo, 'remote', 'set-head', 'origin', '-d');
    git(repo, 'checkout', '-q', '-b', 'feature');
    expect((await createService().open(repo)).mainBranch).toBe('main');
  });

  it('then takes main, then master, when origin cannot tell its default branch', async () => {
    const { origin, repo } = await cloneOfOrigin(['master']);
    // The default of origin points to a branch that does not exist.
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/absente');
    git(repo, 'remote', 'set-head', 'origin', '-d');
    git(repo, 'checkout', '-q', '-b', 'feature');
    expect((await createService().open(repo)).mainBranch).toBe('master');
  });

  it('takes the local main when the network is down and nothing is known', async () => {
    const { repo } = await cloneOfOrigin();
    git(repo, 'remote', 'set-head', 'origin', '-d');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'remote', 'set-url', 'origin', join(root, 'absent.git'));
    expect((await createService().open(repo)).mainBranch).toBe('main');
  });
});

describe('a repository without a remote', () => {
  const localRepo = async (branches: string[], current: string) => {
    const repo = join(root, 'Mes Projets', 'local');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', branches[0] ?? 'main');
    await commit(repo);
    for (const branch of branches.slice(1)) git(repo, 'branch', branch);
    git(repo, 'checkout', '-q', current);
    return repo;
  };

  it('takes main when it exists, whatever the current branch', async () => {
    const repo = await localRepo(['main', 'feature'], 'feature');
    expect((await createService().open(repo)).mainBranch).toBe('main');
  });

  it('takes master when there is no main', async () => {
    const repo = await localRepo(['master', 'feature'], 'feature');
    expect((await createService().open(repo)).mainBranch).toBe('master');
  });

  it('keeps the current branch, as today, when there is neither', async () => {
    const repo = await localRepo(['develop', 'feature'], 'feature');
    expect((await createService().open(repo)).mainBranch).toBe('feature');
  });
});
