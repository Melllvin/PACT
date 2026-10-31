import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../../../src/main/git/git-service';
import { IntegrationService } from '../../../src/main/review/integration-service';
import type { IpcFailure } from '../../../src/shared/ipc';
import type { Agent, Workspace } from '../../../src/shared/model';
import type { Integration } from '../../../src/shared/review';

// 002 T044 — resolving a conflict with main, in PACT or by the agent (research R6, FR-027…FR-031).

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'PACT Test',
  GIT_AUTHOR_EMAIL: 'test@pact.dev',
  GIT_COMMITTER_NAME: 'PACT Test',
  GIT_COMMITTER_EMAIL: 'test@pact.dev',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const status = (cwd: string) =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  });

const AGENT_ID = '00000000-0000-4000-8000-000000000001';

let root: string;
let repo: string;
let worktree: string;
let userData: string;
let workspace: Workspace;
let states: Integration[];
let closed: string[];
let typed: string[];
let opened: string[];

const write = async (path: string, content: string) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
};

const commitAll = (cwd: string, message: string) => {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
};

const agent = (): Agent => ({
  id: AGENT_ID,
  workspaceId: workspace.id,
  position: 1,
  color: 'purple',
  cliId: 'claude-code',
  model: null,
  permissionLevel: 'always-allow',
  baseBranch: 'main',
  branch: 'agent/claude-code-1',
  worktreePath: worktree,
  port: 3001,
  startCommand: null,
  sessionId: null,
  initialPrompt: 'Ajoute le total',
  alwaysAllowRules: [],
  state: 'done',
  lastError: null,
  scheduledResume: null,
  review: { seen: {}, comments: [] },
});

type Options = ConstructorParameters<typeof IntegrationService>[0];

const createService = (overrides: Partial<Options> = {}) =>
  new IntegrationService({
    git: new GitService({ env: gitEnv }),
    workspaces: { list: () => [workspace] },
    agents: {
      close: (id) => {
        closed.push(id);
        return Promise.resolve();
      },
    },
    prompts: {
      sendPrompt: (_id, text) => {
        typed.push(text);
        return Promise.resolve();
      },
    },
    integrationsDir: join(userData, 'integrations'),
    conflictsDir: join(userData, 'conflicts'),
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve();
    },
    watchIntervalMs: 50,
    onState: (integration) => states.push(integration),
    ...overrides,
  });

const start = (service: IntegrationService, mode: Integration['mode'] = 'squash') =>
  service.start({
    agentId: AGENT_ID,
    mode,
    message: 'Ajoute le total',
    after: { closeTile: true, removeWorktree: true },
  });

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as IpcFailure,
  );

const waitFor = async (check: () => boolean, what: string, timeoutMs = 3000) => {
  const begin = Date.now();
  while (!check()) {
    if (Date.now() - begin > timeoutMs) throw new Error(what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** main and the agent change the same line of a.txt; the agent also writes b.txt. */
const conflict = async () => {
  await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
  commitAll(repo, 'Ajout SSO');
  await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
  await write(join(worktree, 'b.txt'), 'b de l’agent\n');
};

let service: IntegrationService;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'pact-conflicts-')));
  repo = join(root, 'Mes Projets', 'Développement');
  userData = join(root, 'userData');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  await write(join(repo, '.git', 'info', 'exclude'), '/.worktrees/\n');
  await write(join(repo, 'a.txt'), 'un\ndeux\ntrois\n');
  await write(join(repo, 'b.txt'), 'b\n');
  await write(join(repo, 'c d é.txt'), 'c\n');
  commitAll(repo, 'initial');
  worktree = join(repo, '.worktrees', 'claude-code-1');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/claude-code-1', worktree, 'main');
  workspace = {
    id: '00000000-0000-4000-8000-0000000000aa',
    path: repo,
    mainBranch: 'main',
    agents: [],
  } as unknown as Workspace;
  workspace = { ...workspace, agents: [agent()] };
  states = [];
  closed = [];
  typed = [];
  opened = [];
  service = createService();
});

afterEach(async () => {
  service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('IntegrationService in conflict (FR-027)', () => {
  it('stops with the hunks of each file, main, its folder and the worktree untouched', async () => {
    await conflict();
    const before = git(repo, 'rev-parse', 'main');
    const worktreeStatus = status(worktree);
    const integration = await start(service);
    expect(integration.state).toBe('conflicted');
    expect(integration.conflicts).toHaveLength(1);
    expect(integration.conflicts[0]).toMatchObject({
      path: 'a.txt',
      kind: 'content',
      whole: false,
      binary: false,
      deleted: null,
      resolved: false,
      hunks: [
        { index: 0, line: 2, main: ['Deux de main'], agent: ['Deux de l’agent'], resolution: null },
      ],
    });
    expect(integration.conflicts[0]?.merged).toContain('<<<<<<<');
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(status(repo)).toBe('');
    expect(status(worktree)).toBe(worktreeStatus);
  });
});

describe('IntegrationService resolving in PACT (FR-029, FR-030)', () => {
  it.each([
    ['main', 'un\nDeux de main\ntrois\n'],
    ['agent', 'un\nDeux de l’agent\ntrois\n'],
    ['both', 'un\nDeux de main\nDeux de l’agent\ntrois\n'],
  ] as const)('commits the choice « %s » with the clean files', async (choice, expected) => {
    await conflict();
    const before = git(repo, 'rev-parse', 'main');
    const { id } = await start(service);
    const resolved = await service.resolve(id, { path: 'a.txt', hunk: 0, choice });
    expect(resolved).toMatchObject({ resolved: true, hunks: [{ resolution: choice }] });
    const done = await service.finish(id);
    expect(done.state).toBe('integrated');
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([
      before,
    ]);
    expect(`${git(repo, 'show', 'main:a.txt')}\n`).toBe(expected);
    expect(git(repo, 'show', 'main:b.txt')).toBe('b de l’agent');
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe(expected);
    expect(closed).toEqual([AGENT_ID]);
  });

  it('commits a content written by hand', async () => {
    await conflict();
    const { id } = await start(service);
    const edited = await service.resolve(id, { path: 'a.txt', content: 'un\nDeux à la main\n' });
    expect(edited).toMatchObject({ resolved: true, edited: 'un\nDeux à la main\n' });
    await service.finish(id);
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDeux à la main');
  });

  it('keeps a content written by hand with markers as not resolved', async () => {
    await conflict();
    const { id, conflicts } = await start(service);
    expect(
      await service.resolve(id, { path: 'a.txt', content: conflicts[0]?.merged ?? '' }),
    ).toMatchObject({ resolved: false });
  });

  it('refuses to finish while a conflict is left, main unchanged', async () => {
    await conflict();
    const before = git(repo, 'rev-parse', 'main');
    const { id } = await start(service);
    expect((await failure(service.finish(id))).code).toBe('INVALID_INPUT');
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
  });

  it('runs the hooks on the final commit; a refusal leaves main as it was', async () => {
    await conflict();
    const before = git(repo, 'rev-parse', 'main');
    const { id } = await start(service);
    await service.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await write(hook, '#!/bin/sh\necho "lint en échec" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const error = await failure(service.finish(id));
    expect(error.code).toBe('GIT_FAILED');
    expect(error.message).toContain('lint en échec');
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    // The resolutions stay: once the hook passes, the same integration ends.
    await rm(hook);
    expect((await service.finish(id)).state).toBe('integrated');
  });

  it('makes a merge commit with the resolutions when keeping commits', async () => {
    await conflict();
    commitAll(worktree, 'Travail de l’agent');
    const head = git(worktree, 'rev-parse', 'HEAD');
    const main = git(repo, 'rev-parse', 'main');
    const { id } = await start(service, 'keep-commits');
    await service.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    await service.finish(id);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([
      main,
      head,
    ]);
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDeux de l’agent\ntrois');
  });

  it('chooses a whole file deleted on one side, without « Les deux »', async () => {
    git(repo, 'rm', '-q', 'c d é.txt');
    git(repo, 'commit', '-q', '-m', 'Supprime c');
    await write(join(worktree, 'c d é.txt'), 'c de l’agent\n');
    const { id, conflicts } = await start(service);
    expect(conflicts[0]).toMatchObject({
      path: 'c d é.txt',
      kind: 'delete-modify',
      whole: true,
      deleted: 'main',
      hunks: [{ index: 0, main: [], agent: ['c de l’agent'], resolution: null }],
    });
    expect(
      (await failure(service.resolve(id, { path: 'c d é.txt', hunk: 0, choice: 'both' }))).code,
    ).toBe('INVALID_INPUT');
    await service.resolve(id, { path: 'c d é.txt', hunk: 0, choice: 'main' });
    await service.finish(id);
    expect(git(repo, 'ls-tree', '--name-only', 'main')).toBe('a.txt\nb.txt');
  });
});

describe('IntegrationService and the external editor (FR-029)', () => {
  it('opens a copy, and reads it back once changed', async () => {
    await conflict();
    const { id } = await start(service);
    await service.openInEditor(id, 'a.txt');
    const copy = join(userData, 'conflicts', id, 'a.txt');
    expect(opened).toEqual([copy]);
    expect(await readFile(copy, 'utf8')).toContain('<<<<<<<');
    await writeFile(copy, 'un\nDeux depuis l’éditeur\ntrois\n');
    await waitFor(
      () => states.at(-1)?.conflicts[0]?.edited === 'un\nDeux depuis l’éditeur\ntrois\n',
      'the edited copy was not read back',
    );
    expect(states.at(-1)?.conflicts[0]?.resolved).toBe(true);
    await service.finish(id);
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDeux depuis l’éditeur\ntrois');
    // The copies go with the integration.
    expect(await readdir(join(userData, 'conflicts')).catch(() => [])).toEqual([]);
  });
});

describe('IntegrationService cancelled (FR-031)', () => {
  it('drops the resolutions and the copies, and changes nothing', async () => {
    await conflict();
    const before = git(repo, 'rev-parse', 'main');
    const worktreeStatus = status(worktree);
    const { id } = await start(service);
    await service.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    await service.openInEditor(id, 'a.txt');
    await service.cancel(id);
    expect(states.at(-1)?.state).toBe('cancelled');
    expect(await readdir(join(userData, 'conflicts')).catch(() => [])).toEqual([]);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
    expect(status(repo)).toBe('');
    expect(status(worktree)).toBe(worktreeStatus);
    expect((await failure(service.finish(id))).code).toBe('NOT_FOUND');
  });
});

describe('IntegrationService asking the agent (FR-028)', () => {
  it('types the conflict prompt, waits for the turn, then checks again and integrates', async () => {
    await conflict();
    const { id } = await start(service);
    const waiting = await service.askAgent(id);
    expect(waiting.state).toBe('waiting-agent');
    expect(typed).toEqual([
      'Ta branche est en conflit avec main sur : a.txt.\nMets ta branche à jour depuis main dans ton worktree (rebase ou merge), résous les conflits, puis relance les tests.',
    ]);
    // Ready again before working on it: still waiting.
    service.agentState(AGENT_ID, 'done');
    expect(states.at(-1)?.state).toBe('waiting-agent');
    // The agent merges main and resolves in its worktree.
    service.agentState(AGENT_ID, 'working');
    commitAll(worktree, 'Avant la mise à jour');
    // Its own resolution: main merged in, a.txt written by hand.
    git(worktree, 'merge', '-q', '-s', 'ours', '-m', 'Met à jour depuis main', 'main');
    await write(join(worktree, 'a.txt'), 'un\nDeux réconcilié\ntrois\n');
    commitAll(worktree, 'Résout le conflit');
    service.agentState(AGENT_ID, 'done');
    await waitFor(() => states.at(-1)?.state === 'integrated', 'not integrated after the agent');
    expect(git(repo, 'show', 'main:a.txt')).toBe('un\nDeux réconcilié\ntrois');
    expect(states.at(-1)?.id).toBe(id);
  });
});

describe('IntegrationService refusals and edge cases', () => {
  it('refuses an unknown integration, file or conflict', async () => {
    await conflict();
    const { id } = await start(service);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await failure(service.finish(unknown))).code).toBe('NOT_FOUND');
    expect(
      (await failure(service.resolve(id, { path: 'b.txt', hunk: 0, choice: 'main' }))).code,
    ).toBe('NOT_FOUND');
    expect(
      (await failure(service.resolve(id, { path: 'a.txt', hunk: 4, choice: 'main' }))).code,
    ).toBe('NOT_FOUND');
    expect((await failure(service.openInEditor(id, 'b.txt'))).code).toBe('NOT_FOUND');
  });

  it('resolves one conflict of a file, and one file, leaving the others as they were', async () => {
    const lines = (two: string, eight: string) =>
      `un\n${two}\ntrois\nquatre\ncinq\nsix\nsept\n${eight}\nneuf\n`;
    await write(join(repo, 'b.txt'), lines('deux', 'huit'));
    commitAll(repo, 'b sur neuf lignes');
    git(worktree, 'merge', '-q', 'main');
    await write(join(repo, 'b.txt'), lines('deux de main', 'huit de main'));
    await write(join(repo, 'a.txt'), 'un\nDeux de main\ntrois\n');
    commitAll(repo, 'Ajout SSO');
    await write(join(worktree, 'b.txt'), lines('deux de l’agent', 'huit de l’agent'));
    await write(join(worktree, 'a.txt'), 'un\nDeux de l’agent\ntrois\n');
    const { id, conflicts } = await start(service);
    expect(conflicts.map((f) => [f.path, f.hunks.length])).toEqual([
      ['a.txt', 1],
      ['b.txt', 2],
    ]);
    const b = await service.resolve(id, { path: 'b.txt', hunk: 1, choice: 'agent' });
    expect(b.hunks.map((h) => h.resolution)).toEqual([null, 'agent']);
    expect(b.resolved).toBe(false);
    expect(states.at(-1)?.conflicts[0]?.hunks[0]?.resolution).toBeNull();
  });

  it('says main moved during the resolution, and keeps the resolutions', async () => {
    await conflict();
    const { id } = await start(service);
    await service.resolve(id, { path: 'a.txt', hunk: 0, choice: 'agent' });
    await write(join(repo, 'c d é.txt'), 'c ailleurs\n');
    commitAll(repo, 'Ailleurs');
    const moved = git(repo, 'rev-parse', 'main');
    const error = await failure(service.finish(id));
    expect(error.code).toBe('MAIN_MOVED');
    expect(git(repo, 'rev-parse', 'main')).toBe(moved);
    expect(states.at(-1)).toMatchObject({
      state: 'conflicted',
      conflicts: [{ resolved: true }],
    });
  });

  it('chooses a binary file whole, with no lines to show', async () => {
    await write(join(repo, 'logo.bin'), 'logo\0de base');
    commitAll(repo, 'Ajoute le logo');
    git(worktree, 'merge', '-q', 'main');
    await write(join(repo, 'logo.bin'), 'logo\0de main');
    commitAll(repo, 'Logo de main');
    await write(join(worktree, 'logo.bin'), 'logo\0de l’agent');
    const { id, conflicts } = await start(service);
    expect(conflicts[0]).toMatchObject({
      path: 'logo.bin',
      whole: true,
      binary: true,
      merged: '',
      hunks: [{ main: [], agent: [] }],
    });
    await service.resolve(id, { path: 'logo.bin', hunk: 0, choice: 'agent' });
    await service.finish(id);
    expect(git(repo, 'cat-file', '-p', 'main:logo.bin')).toBe('logo\0de l’agent');
  });

  it('keeps the deletion made by the agent when its side is chosen', async () => {
    await write(join(repo, 'b.txt'), 'b de main\n');
    commitAll(repo, 'b de main');
    await rm(join(worktree, 'b.txt'));
    const { id, conflicts } = await start(service);
    expect(conflicts[0]).toMatchObject({ path: 'b.txt', deleted: 'agent', whole: true });
    await service.resolve(id, { path: 'b.txt', hunk: 0, choice: 'agent' });
    await service.finish(id);
    expect(git(repo, '-c', 'core.quotePath=false', 'ls-tree', '--name-only', 'main')).toBe(
      'a.txt\nc d é.txt',
    );
  });

  it('works without an editor or an agent to ask, and without anyone to tell', async () => {
    service.dispose();
    service = new IntegrationService({
      git: new GitService({ env: gitEnv }),
      workspaces: { list: () => [workspace] },
      agents: { close: () => Promise.resolve() },
      integrationsDir: join(userData, 'integrations'),
    });
    await conflict();
    const { id } = await start(service);
    expect((await failure(service.openInEditor(id, 'a.txt'))).code).toBe('INTERNAL');
    expect((await failure(service.askAgent(id))).code).toBe('INTERNAL');
    await service.cancel(id);
    expect((await failure(service.finish(id))).code).toBe('NOT_FOUND');
    expect(states).toEqual([]);
  });

  it('follows only the agent asked, and cancels when it is closed', async () => {
    await conflict();
    const { id } = await start(service);
    service.agentState(AGENT_ID, 'working');
    service.agentState(AGENT_ID, 'done');
    // Not asked yet: nothing is checked again.
    expect(states.at(-1)?.state).toBe('conflicted');
    await service.askAgent(id);
    service.agentState('00000000-0000-4000-8000-000000000002', 'working');
    service.agentState(AGENT_ID, 'closed');
    await waitFor(() => states.at(-1)?.state === 'cancelled', 'not cancelled');
  });

  it('reads nothing back once disposed, nor from a copy deleted meanwhile', async () => {
    await conflict();
    const { id } = await start(service);
    await service.openInEditor(id, 'a.txt');
    const copy = join(userData, 'conflicts', id, 'a.txt');
    await rm(copy);
    await new Promise((r) => setTimeout(r, 200));
    expect(states.at(-1)?.conflicts[0]?.edited).toBeNull();
    await service.openInEditor(id, 'a.txt');
    service.dispose();
    await writeFile(copy, 'trop tard\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(states.at(-1)?.conflicts[0]?.edited).toBeNull();
  });

  it('says why the integration failed when it is checked again after the agent', async () => {
    await conflict();
    const { id } = await start(service);
    await service.askAgent(id);
    service.agentState(AGENT_ID, 'working');
    commitAll(worktree, 'Avant la mise à jour');
    git(worktree, 'merge', '-q', '-s', 'ours', '-m', 'Met à jour depuis main', 'main');
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await write(hook, '#!/bin/sh\necho "lint en échec" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    service.agentState(AGENT_ID, 'done');
    await waitFor(() => states.at(-1)?.state === 'failed', 'no failure after the agent');
    expect(states.at(-1)?.error).toContain('lint en échec');
  });
});
