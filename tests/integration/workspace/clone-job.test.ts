import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEvent } from '../../../src/shared/ipc';
import { GitService } from '../../../src/main/git/git-service';
import { openStores } from '../../../src/main/persistence/store';
import { CloneJobs } from '../../../src/main/workspace/clone-job';
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
let bareUrl: string;
let events: IpcEvent<'clone:progress'>[];
let jobs: CloneJobs;
let workspaces: WorkspaceService;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-clone-')));
  const source = join(root, 'source');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  await writeFile(join(source, 'README.md'), '# test\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  git(root, 'clone', '--bare', source, join(root, 'origin.git'));
  bareUrl = pathToFileURL(join(root, 'origin.git')).href;

  const gitService = new GitService({ env: gitEnv });
  workspaces = new WorkspaceService({
    git: gitService,
    stores: openStores(join(root, 'userData')),
  });
  events = [];
  jobs = new CloneJobs({ git: gitService, workspaces, emit: (event) => events.push(event) });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const finished = async () => {
  for (let i = 0; i < 500; i++) {
    const last = events.at(-1);
    if (last && ('workspace' in last || 'error' in last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`clone did not finish: ${JSON.stringify(events)}`);
};

describe('CloneJobs', () => {
  it('reports progress, then opens the cloned repository as a workspace', async () => {
    const destination = join(root, 'Mes Projets', 'clone é');
    const { jobId } = jobs.start({ url: bareUrl, destination });

    const last = await finished();
    expect(last).toMatchObject({ jobId, workspace: { path: destination, name: 'clone é' } });
    expect(events.some((e) => 'percent' in e && e.jobId === jobId)).toBe(true);
    expect(workspaces.list().map((w) => w.path)).toEqual([destination]);
  });

  it('gives each clone its own job id', async () => {
    const first = jobs.start({ url: bareUrl, destination: join(root, 'a') });
    const second = jobs.start({ url: bareUrl, destination: join(root, 'b') });
    expect(first.jobId).not.toBe(second.jobId);
    // Let both clones finish before the temporary folder is removed.
    for (let i = 0; i < 500 && events.filter((e) => 'workspace' in e).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(events.filter((e) => 'workspace' in e)).toHaveLength(2);
  });

  it('reports a clear error, removes the partial folder and opens no tab on failure', async () => {
    const destination = join(root, 'broken');
    const { jobId } = jobs.start({
      url: pathToFileURL(join(root, 'missing.git')).href,
      destination,
    });

    const last = await finished();
    expect(last).toMatchObject({ jobId, error: { code: 'CLONE_FAILED' } });
    expect('error' in last && last.error.message).toMatch(/missing/);
    await expect(stat(destination)).rejects.toThrow();
    expect(workspaces.list()).toEqual([]);
  });

  it('refuses a non-empty destination without touching it', async () => {
    const destination = join(root, 'occupied');
    await mkdir(destination);
    await writeFile(join(destination, 'keep.txt'), 'précieux');

    jobs.start({ url: bareUrl, destination });
    const last = await finished();
    expect(last).toMatchObject({ error: { code: 'CLONE_FAILED' } });
    expect((await stat(join(destination, 'keep.txt'))).isFile()).toBe(true);
  });
});
