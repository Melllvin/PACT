import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

// fix-todo-diff-notifications — a workspace restored at launch gets its main branch calculated again.

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
const services: WorkspaceService[] = [];

const service = () => {
  const created = new WorkspaceService({
    git: new GitService({ env: gitEnv }),
    stores: openStores(join(root, 'userData')),
  });
  services.push(created);
  return created;
};

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-ws-restore-')));
  repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'checkout', '-q', '-b', 'feature');
});

afterEach(async () => {
  for (const created of services.splice(0)) created.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('WorkspaceService.restore and the main branch', () => {
  it('calculates it again, the root folder being on another branch', async () => {
    await service().open(repo);
    const [restored] = await service().restore();
    expect(restored?.mainBranch).toBe('main');
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  });

  it('keeps the saved one for a folder that is gone', async () => {
    const first = service();
    const { id } = await first.open(repo);
    await rm(repo, { recursive: true, force: true });
    const restored = await service().restore();
    expect(restored.find((ws) => ws.id === id)).toMatchObject({
      status: 'unavailable',
      mainBranch: 'main',
    });
  });

  it('has none for a folder that is gone and was never saved', async () => {
    const stores = openStores(join(root, 'userData'));
    await stores.state.write({
      ...(await stores.state.read()),
      openWorkspaces: [join(root, 'gone')],
    });
    const [restored] = await service().restore();
    expect(restored).toMatchObject({ status: 'unavailable', mainBranch: '' });
  });
});
