import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAppServices,
  devServerUrl,
  trustedSenderCheck,
} from '../../../src/main/app-services';
import { GitService } from '../../../src/main/git/git-service';
import { openStores, type Stores } from '../../../src/main/persistence/store';
import { CloneJobs } from '../../../src/main/workspace/clone-job';
import { WorkspaceService } from '../../../src/main/workspace/workspace-service';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};

let dir: string;
let stores: Stores;
let workspaces: WorkspaceService;
let pickFolder: ReturnType<typeof vi.fn<(purpose: string) => Promise<string | null>>>;
let services: ReturnType<typeof createAppServices>;
let cloneEvents: unknown[];

const makeRepo = async (name: string) => {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: path, env: gitEnv });
  await writeFile(join(path, 'a.txt'), 'a');
  execFileSync('git', ['add', '.'], { cwd: path, env: gitEnv });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: path, env: gitEnv });
  return path;
};

beforeEach(async () => {
  dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-services-')));
  stores = openStores(join(dir, 'userData'));
  const git = new GitService({ env: gitEnv });
  workspaces = new WorkspaceService({ git, stores });
  pickFolder = vi.fn<(purpose: string) => Promise<string | null>>();
  cloneEvents = [];
  services = createAppServices({
    stores,
    workspaces,
    clones: new CloneJobs({ git, workspaces, emit: (event) => cloneEvents.push(event) }),
    pickFolder,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('app:getState', () => {
  it('returns an empty state on first launch', async () => {
    expect(await services['app:getState']()).toEqual({
      workspaces: [],
      recents: [],
      clis: [],
      permission: null,
    });
  });

  it('returns the open workspaces, recents and the global permission', async () => {
    await stores.state.write({
      openWorkspaces: [],
      recents: [],
      customClis: [],
      permission: { level: 'ask-sensitive', autoResume: false, scope: 'global' },
    });
    await services['workspace:open']({ path: await makeRepo('app') });
    expect(await services['app:getState']()).toMatchObject({
      workspaces: [{ name: 'app' }],
      recents: [{ name: 'app' }],
      permission: { level: 'ask-sensitive', autoResume: false, scope: 'global' },
    });
  });
});

describe('app:getState with CLI detection', () => {
  it('lists the detected CLIs', async () => {
    const clis = [
      {
        id: 'codex',
        name: 'Codex',
        adapter: 'codex',
        command: 'codex',
        resolvedPath: '/bin/codex',
        version: '0.156.1',
        origin: 'detected',
        status: 'installed',
        models: [],
      },
    ] as const;
    const withClis = createAppServices({
      stores,
      workspaces,
      clones: new CloneJobs({ git: new GitService({ env: gitEnv }), workspaces, emit: vi.fn() }),
      pickFolder,
      clis: () => Promise.resolve([...clis]),
    });
    expect((await withClis['app:getState']()).clis).toEqual(clis);
  });

  it('prepares a reopened workspace (agents to resume, free terminals)', async () => {
    const onOpened = vi.fn(() => Promise.resolve());
    const withHook = createAppServices({
      stores,
      workspaces,
      clones: new CloneJobs({ git: new GitService({ env: gitEnv }), workspaces, emit: vi.fn() }),
      pickFolder,
      onOpened,
    });
    const opened = await withHook['workspace:open']({ path: await makeRepo('app') });
    expect(onOpened).toHaveBeenCalledWith(opened.id);
  });
});

describe('workspace channels', () => {
  it('opens, inits and closes workspaces through WorkspaceService', async () => {
    const opened = await services['workspace:open']({ path: await makeRepo('app') });
    const plain = join(dir, 'plain');
    await mkdir(plain);
    const initialized = await services['workspace:initRepo']({ path: plain });
    expect(workspaces.list().map((w) => w.id)).toEqual([opened.id, initialized.id]);
    await services['workspace:close']({ id: opened.id });
    expect(workspaces.list().map((w) => w.id)).toEqual([initialized.id]);
  });

  it('starts clones in the background and returns their job id', async () => {
    const source = await makeRepo('source');
    const { jobId } = services['workspace:clone']({
      url: pathToFileURL(source).href,
      destination: join(dir, 'copy'),
    });
    expect(jobId).toMatch(/[0-9a-f-]{36}/);
    // Wait for the completion event: it is emitted once the workspace is fully persisted.
    const done = () =>
      cloneEvents.some((e) => typeof e === 'object' && e !== null && 'workspace' in e);
    for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(workspaces.list().map((w) => w.name)).toEqual(['copy']);
  });

  it('asks the main process for a folder', async () => {
    pickFolder.mockResolvedValue('/Users/me/repo');
    expect(await services['dialog:pickFolder']({ purpose: 'open-repository' })).toBe(
      '/Users/me/repo',
    );
    expect(pickFolder).toHaveBeenCalledWith('open-repository');
  });
});

describe('devServerUrl', () => {
  it('uses the electron-vite dev server only in an unpackaged app', () => {
    const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173/' };
    expect(devServerUrl({ isPackaged: false }, env)).toBe('http://localhost:5173/');
    // A packaged app must never let an environment variable swap its UI for a remote page.
    expect(devServerUrl({ isPackaged: true }, env)).toBeUndefined();
    expect(devServerUrl({ isPackaged: false }, {})).toBeUndefined();
  });
});

describe('trustedSenderCheck', () => {
  const rendererHtml = join(tmpdir(), 'out', 'renderer', 'index.html');

  it('trusts the built renderer page', () => {
    const trusted = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(trusted(pathToFileURL(rendererHtml).href)).toBe(true);
  });

  it('refuses other files and remote pages', () => {
    const trusted = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(trusted(pathToFileURL(join(tmpdir(), 'evil.html')).href)).toBe(false);
    expect(trusted('https://example.com/')).toBe(false);
    expect(trusted('not a url')).toBe(false);
  });

  it('trusts the dev server origin only when electron-vite provides it', () => {
    const dev = trustedSenderCheck({ rendererHtml, devServerUrl: 'http://localhost:5173/' });
    expect(dev('http://localhost:5173/')).toBe(true);
    expect(dev('http://localhost:5173/index.html')).toBe(true);
    expect(dev('http://localhost:5174/')).toBe(false);
    const prod = trustedSenderCheck({ rendererHtml, devServerUrl: undefined });
    expect(prod('http://localhost:5173/')).toBe(false);
  });
});
